/**
 * loader.js
 * * Модуль для потоковой загрузки и парсинга графа.
 * * ПОЧЕМУ ТАК СЛОЖНО?
 * Стандартный JSON.parse() требует загрузки всего файла в строку. 
 * Для графа в 500МБ это создаст строку в 500МБ + объекты в памяти = Crash.
 * * РЕШЕНИЕ:
 * Мы читаем поток байт, декодируем их в текст кусочками и ищем объекты 
 * вручную, используя конечный автомат (State Machine).
 */

export async function loadGraphStream(readableStream, onProgress) {
    if (!readableStream) throw new Error("No stream provided");

    // 1. Настройка потока декомпрессии (GZIP)
    // Браузер сам распаковывает .gz на лету.
    const ds = new DecompressionStream("gzip");
    const decompressedStream = readableStream.pipeThrough(ds);
    const reader = decompressedStream.getReader();

    const decoder = new TextDecoder("utf-8");

    // 2. Выделение памяти (Typed Arrays)
    // Аналог std::vector<float> с reserve() в C++.
    // Используем плоские массивы для максимальной скорости GPU.
    let capacityNodes = 1000000; // Старт с 1 млн узлов
    let capacityLinks = 1000000; 
    
    let nodeCount = 0;
    let linkCount = 0;

    // Arrays for Nodes (Structure of Arrays layout)
    let xArr = new Float32Array(capacityNodes);
    let yArr = new Float32Array(capacityNodes);
    let sizeArr = new Float32Array(capacityNodes);
    let rArr = new Float32Array(capacityNodes); // Red
    let gArr = new Float32Array(capacityNodes); // Green
    let bArr = new Float32Array(capacityNodes); // Blue
    let labelsArr = new Array(capacityNodes);   // JS Strings are managed by V8

    // Arrays for Links
    let linkSrc = new Uint32Array(capacityLinks);
    let linkTgt = new Uint32Array(capacityLinks);

    // Буфер для склейки кусков текста
    let buffer = '';
    // Состояние нашего конечного автомата
    let state = 'SEARCH_NODES'; 
    let totalBytes = 0;

    // --- Helpers ---

    function resizeNodes() {
        // Удваиваем размер (Amortized O(1) insertion)
        capacityNodes *= 2;
        // console.log("Resizing nodes to", capacityNodes);

        const newX = new Float32Array(capacityNodes); newX.set(xArr); xArr = newX;
        const newY = new Float32Array(capacityNodes); newY.set(yArr); yArr = newY;
        const newS = new Float32Array(capacityNodes); newS.set(sizeArr); sizeArr = newS;
        const newR = new Float32Array(capacityNodes); newR.set(rArr); rArr = newR;
        const newG = new Float32Array(capacityNodes); newG.set(gArr); gArr = newG;
        const newB = new Float32Array(capacityNodes); newB.set(bArr); bArr = newB;
    }

    function resizeLinks() {
        capacityLinks *= 2;
        const newSrc = new Uint32Array(capacityLinks); newSrc.set(linkSrc); linkSrc = newSrc;
        const newTgt = new Uint32Array(capacityLinks); newTgt.set(linkTgt); linkTgt = newTgt;
    }

    // Быстрый парсинг цвета #RRGGBB
    function parseColor(hexStr, idx) {
        if (!hexStr) return;
        if (hexStr.startsWith('#')) hexStr = hexStr.slice(1);
        
        // Битовые сдвиги в JS медленнее parseInt для строк, так что так:
        const r = parseInt(hexStr.substring(0, 2), 16) / 255.0;
        const g = parseInt(hexStr.substring(2, 4), 16) / 255.0;
        const b = parseInt(hexStr.substring(4, 6), 16) / 255.0;
        
        rArr[idx] = r || 0.5;
        gArr[idx] = g || 0.5;
        bArr[idx] = b || 0.5;
    }

    // --- Main Loop ---

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.length;
        // Декодируем байты в текст и добавляем в хвост буфера
        buffer += decoder.decode(value, { stream: true });

        // Обрабатываем буфер, пока можем извлечь данные
        while (true) {
            // STATE 1: Ищем начало списка узлов "nodes":[
            if (state === 'SEARCH_NODES') {
                const idx = buffer.indexOf('"nodes":[');
                if (idx !== -1) {
                    buffer = buffer.slice(idx + 9); // Пропускаем заголовок
                    state = 'IN_NODES';
                } else {
                    // Оставляем только "хвост" буфера на случай, если ключ разрезало пополам
                    if (buffer.length > 50) buffer = buffer.slice(-50); 
                    break; // Ждем больше данных
                }
            }

            // STATE 2 & 3: Читаем объекты внутри массивов
            if (state === 'IN_NODES' || state === 'IN_LINKS') {
                // Чистим мусор (запятые, пробелы)
                buffer = buffer.trimStart();
                if (buffer.startsWith(',')) buffer = buffer.slice(1).trimStart();

                // Проверка на конец массива ']'
                if (buffer.startsWith(']')) {
                    buffer = buffer.slice(1);
                    // Если закончили узлы -> ищем связи. Если закончили связи -> всё.
                    state = (state === 'IN_NODES') ? 'SEARCH_LINKS' : 'DONE';
                    
                    if (state === 'DONE') {
                        // ВОЗВРАЩАЕМ РЕЗУЛЬТАТ
                        // Обрезаем массивы (.slice) до реального количества элементов
                        return {
                            nodeCount, linkCount,
                            x: xArr.slice(0, nodeCount),
                            y: yArr.slice(0, nodeCount),
                            size: sizeArr.slice(0, nodeCount),
                            r: rArr.slice(0, nodeCount),
                            g: gArr.slice(0, nodeCount),
                            b: bArr.slice(0, nodeCount),
                            labels: labelsArr.slice(0, nodeCount),
                            linkSrc: linkSrc.slice(0, linkCount),
                            linkTgt: linkTgt.slice(0, linkCount)
                        };
                    }
                    continue;
                }

                // Попытка найти полный JSON-объект {...}
                if (buffer.startsWith('{')) {
                    // Нам нужно найти закрывающую скобку }
                    // ВАЖНО: Просто искать '}' нельзя, так как она может быть внутри строки label.
                    // Примитивный сканер баланса скобок:
                    
                    let endIdx = -1;
                    let braceCount = 0;
                    let inString = false;

                    for (let i = 0; i < buffer.length; i++) {
                        const char = buffer[i];
                        // Если встречаем кавычку и она не экранирована
                        if (char === '"' && buffer[i - 1] !== '\\') { 
                            inString = !inString; 
                            continue; 
                        }
                        if (inString) continue; // Внутри строки игнорируем скобки

                        if (char === '{') braceCount++;
                        else if (char === '}') {
                            braceCount--;
                            if (braceCount === 0) {
                                endIdx = i;
                                break;
                            }
                        }
                    }

                    if (endIdx !== -1) {
                        // Ура, у нас есть полный текст одного объекта
                        const objStr = buffer.slice(0, endIdx + 1);
                        buffer = buffer.slice(endIdx + 1); // Удаляем обработанное из буфера

                        try {
                            // Парсим только этот маленький кусочек
                            const obj = JSON.parse(objStr);

                            if (state === 'IN_NODES') {
                                if (nodeCount >= capacityNodes) resizeNodes();
                                
                                xArr[nodeCount] = obj.x;
                                yArr[nodeCount] = obj.y;
                                sizeArr[nodeCount] = obj.size || 2.0;
                                parseColor(obj.color, nodeCount);
                                labelsArr[nodeCount] = obj.label || ""; 
                                
                                nodeCount++;
                                if (nodeCount % 50000 === 0) onProgress(`Loading nodes: ${nodeCount}`);
                            
                            } else { // IN_LINKS
                                if (linkCount >= capacityLinks) resizeLinks();
                                
                                linkSrc[linkCount] = obj.source; 
                                linkTgt[linkCount] = obj.target;
                                
                                linkCount++;
                                if (linkCount % 50000 === 0) onProgress(`Loading links: ${linkCount}`);
                            }
                        } catch (e) {
                            console.warn("Skipping bad JSON chunk", e);
                        }
                        continue; // Сразу ищем следующий объект
                    } else {
                        // Не нашли закрывающую скобку -> объект пришел не полностью
                        // Прерываем внутренний цикл, ждем следующий чанк из сети
                        break; 
                    }
                } else {
                    // Если мы здесь, значит буфер начинается не с '{' и не с ']'.
                    // Возможно, мы в фазе перехода между массивами ("nodes": [...] , "links": [...])
                    if (buffer.indexOf('"links":[') !== -1) {
                         // Пропускаем мусор до начала links
                        let idx = buffer.indexOf('"links":[');
                        buffer = buffer.slice(idx + 9);
                        state = 'IN_LINKS';
                        continue;
                    }
                    // Если совсем непонятно что — ждем данных (или это конец файла)
                    break;
                }
            }

            if (state === 'SEARCH_LINKS') {
                const idx = buffer.indexOf('"links":[');
                if (idx !== -1) {
                    buffer = buffer.slice(idx + 9);
                    state = 'IN_LINKS';
                } else {
                    if (buffer.length > 50) buffer = buffer.slice(-50);
                    break;
                }
            }
        }
    }

    return {
        nodeCount, linkCount,
        x: xArr.slice(0, nodeCount),
        y: yArr.slice(0, nodeCount),
        labels: labelsArr.slice(0, nodeCount),
        // ... вернем то, что успели накопить, даже если поток оборвался
        size: sizeArr.slice(0, nodeCount),
        r: rArr.slice(0, nodeCount), g: gArr.slice(0, nodeCount), b: bArr.slice(0, nodeCount),
        linkSrc: linkSrc.slice(0, linkCount), linkTgt: linkTgt.slice(0, linkCount)
    };
}