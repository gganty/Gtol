/**
 * Iterative Tree Algorithms (Port of tree_algo.py)
 * Designed for high-performance in Web Workers.
 */

// configuration constants
const DEFAULT_PARAMS = {
    x_scale: 140.0,
    min_level_gap: 56.0,
    leaf_step: 400.0,
    parent_stub: 20.0,
    tip_pad: 40.0,
    weighted_stub: 40.0,
    node_size_scale: 2.0
};

// geometry & colors
const SIZE_LEAF_MARKER = 20.0;
const SIZE_INTERNAL = 6.0;
const SIZE_BEND = 3.0;
const SIZE_LEAF_REAL = 8.0;

const COLOR_LEAF = [0.96, 0.84, 0.43]; // #f5d76e
const COLOR_INTERNAL = [0.54, 0.71, 0.97]; // #8ab4f8
const COLOR_BEND = [0.6, 0.63, 0.65]; // #9aa0a6
const COLOR_LINK = [0.59, 0.63, 0.66]; // #97A1A9

// 1. Parsing (iterative)

/**
 * Parses Newick string/buffer into a flat structure.
 * uses Uint32Arrays for topology to save memory.
 * 
 * @param {string} text - Raw Newick string.
 * @param {Function} onProgress - Callback(percent).
 * @returns {Object} - { parent: Uint32Array, children: Array<Int32Array>, names: Array<string>, blens: Float32Array, rootId: number }
 */
export function parseNewick(text, onProgress) {
    const len = text.length;
    let i = 0;

    let estimatedNodes = Math.ceil(len / 5);
    // start with a reasonable capacity
    let capacity = 100000;

    // topology arrays
    // id is implicitly the index
    let parent = new Int32Array(capacity).fill(-1);
    let children = new Array(capacity);
    // for children, since count is variable, Array of Arrays is easiest for construction.
    // if memory is critical, we can use a huge Uint32Array + Offset array.
    // V8 handles Arrays of Integers very efficiently.
    for (let k = 0; k < capacity; k++) children[k] = [];

    let blens = new Float32Array(capacity).fill(0.0);
    let names = new Array(capacity).fill("");

    let nextId = 0;

    function ensureCapacity() {
        if (nextId >= capacity) {
            let newCap = capacity * 2;
            let newParent = new Int32Array(newCap).fill(-1);
            newParent.set(parent);
            parent = newParent;

            let newBlens = new Float32Array(newCap);
            newBlens.set(blens);
            blens = newBlens;

            for (let k = capacity; k < newCap; k++) {
                children[k] = [];
            }
            capacity = newCap;
        }
    }

    let stack = []; // stack of parent IDs
    let currentParent = -1;

    // tokenization state (manual char iteration is faster than regex for 500MB)

    let lastClosed = -1;
    let tokensProcessed = 0;

    while (i < len) {
        let char = text[i];

        // skip whitespace
        if (char <= ' ') {
            i++; continue;
        }

        if (tokensProcessed % 50000 === 0 && onProgress) {
            onProgress((i / len) * 0.3); // parsing is 30% of work
        }
        tokensProcessed++;

        if (char === '(') {
            ensureCapacity();
            let u = nextId++;

            if (currentParent !== -1) {
                children[currentParent].push(u);
                parent[u] = currentParent;
            }
            stack.push(currentParent);
            currentParent = u;
            lastClosed = -1;
            i++;
        }
        else if (char === ',') {
            lastClosed = -1;
            i++;
        }
        else if (char === ')') {
            lastClosed = currentParent;
            currentParent = stack.pop();
            i++;
        }
        else if (char === ';') {
            break; // end
        }
        else if (char === ':') {
            // branch length
            i++;
            let start = i;
            while (i < len) {
                let c = text.charCodeAt(i);
                // 0-9, ., +, -, e, E
                if ((c >= 48 && c <= 57) || c === 46 || c === 43 || c === 45 || c === 101 || c === 69) {
                    i++;
                } else {
                    break;
                }
            }
            let distStr = text.substring(start, i);
            let dist = parseFloat(distStr) || 0;

            let target = (lastClosed !== -1) ? lastClosed : (nextId - 1);
            if (target >= 0) {
                blens[target] = dist;
            }
        }
        else {
            // name / label
            let start = i;
            let quoted = false;
            if (char === "'" || char === '"') {
                quoted = true;
                let qChar = char;
                i++; // skip quote
                start = i;
                while (i < len && text[i] !== qChar) i++;
                // i is now at closing quote
            } else {
                while (i < len) {
                    let c = text[i];
                    if (c === '(' || c === ')' || c === ',' || c === ':' || c === ';') break;
                    i++;
                }
            }

            let label = text.substring(start, i);
            if (quoted) i++; // skip closing quote

            if (lastClosed !== -1) {
                // labeling an internal node we just closed
                names[lastClosed] = label;
            } else {
                // new leaf
                ensureCapacity();
                let u = nextId++;
                names[u] = label;
                if (currentParent !== -1) {
                    children[currentParent].push(u);
                    parent[u] = currentParent;
                }
                lastClosed = u;
            }
        }
    }

    // find root (parent == -1)
    let root = 0;
    for (let k = 0; k < nextId; k++) {
        if (parent[k] === -1) {
            root = k;
            break;
        }
    }

    return {
        count: nextId,
        parent: parent.subarray(0, nextId),
        children: children.slice(0, nextId),
        names: names.slice(0, nextId),
        blens: blens.subarray(0, nextId),
        root: root
    };
}


// 2. Layout (iterative)

/**
 * computes logical X,Y coordinates.
 * X = Cumulative branch length
 * Y = Equal leaf spacing
 */
export function computeLayout(tree, onProgress) {
    const { count, parent, children, names, blens, root } = tree;
    const { leaf_step } = DEFAULT_PARAMS;

    // a. compute X (cumulative distance)

    let dist = new Float32Array(count);
    let stack = [root];
    dist[root] = 0.0;

    while (stack.length > 0) {
        let u = stack.pop();
        let d = dist[u];
        let kids = children[u];
        for (let i = 0; i < kids.length; i++) {
            let v = kids[i];
            dist[v] = d + Math.max(0.0, blens[v]);
            stack.push(v);
        }
    }

    if (onProgress) onProgress(0.4);

    // b. compute Y (leaf spacing)
    // 1. collect leaves (DFS)
    // 2. assign Y to leaves
    // 3. post-order calc internal Y (mean of children)

    let y = new Float32Array(count);
    let leaves = [];

    // iterative DFS to collect leaves
    stack = [root];
    let postOrder = [];

    // DFS for post-order
    let s1 = [root];
    while (s1.length > 0) {
        let u = s1.pop();
        postOrder.push(u);
        let kids = children[u];
        for (let i = 0; i < kids.length; i++) {
            s1.push(kids[i]);
        }
    }
    // postOrder is currently pre-order, reverse to get post-order
    postOrder.reverse();

    // identify leaves
    // -- sort children for no-crossing (min leaf name) --

    // determine "min leaf name" for each node
    let minLeaf = new Array(count);

    for (let u of postOrder) {
        if (children[u].length === 0) {
            minLeaf[u] = names[u] || "";
        } else {
            let kids = children[u];
            // sort kids in place
            kids.sort((a, b) => {
                let sa = minLeaf[a];
                let sb = minLeaf[b];
                return sa < sb ? -1 : (sa > sb ? 1 : 0);
            });

            minLeaf[u] = minLeaf[kids[0]];
        }
    }

    if (onProgress) onProgress(0.5);

    // re-collect leaves in the *sorted* DFS order
    stack = [root];
    let sortedLeaves = [];
    while (stack.length > 0) {
        let u = stack.pop();
        let kids = children[u];
        if (kids.length === 0) {
            sortedLeaves.push(u);
        } else {
            // push in reverse so they pop in order
            for (let i = kids.length - 1; i >= 0; i--) {
                stack.push(kids[i]);
            }
        }
    }

    // assign Y to leaves
    for (let i = 0; i < sortedLeaves.length; i++) {
        y[sortedLeaves[i]] = i * leaf_step;
    }

    // propagate Y up (post-order again)
    for (let u of postOrder) {
        let kids = children[u];
        if (kids.length > 0) {
            let sumY = 0;
            for (let v of kids) sumY += y[v];
            y[u] = sumY / kids.length;
        }
    }

    return { x: dist, y: y, postOrder, sortedLeaves };
}


// 3. Build visual graph (points & links)

export function buildVisualGraph(tree, layout, onProgress) {
    const { count, children, names, blens } = tree;
    const { x: dist, y } = layout;
    const { x_scale, min_level_gap, parent_stub, tip_pad, weighted_stub } = DEFAULT_PARAMS;

    // 1. x-scaling & stem spreading
    // collect all vertical stems: x_px + stub

    let rawStems = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        rawStems[i] = dist[i] * x_scale + parent_stub;
    }

    // robust quantization & spreading
    // 1. quantize all X positions (integers)
    let stemsQ = new Int32Array(count);
    for (let i = 0; i < count; i++) stemsQ[i] = Math.round(rawStems[i] * 10.0);

    // 2. sort & deduplicate
    let sortedQ = new Int32Array(stemsQ);
    sortedQ.sort();

    let uniqueQ = [];
    if (sortedQ.length > 0) {
        uniqueQ.push(sortedQ[0]);
        for (let i = 1; i < sortedQ.length; i++) {
            if (sortedQ[i] !== sortedQ[i - 1]) {
                uniqueQ.push(sortedQ[i]);
            }
        }
    }

    // 3. spread (layout logic)
    let stemMap = new Map();
    let last = -Infinity;

    for (let i = 0; i < uniqueQ.length; i++) {
        let qVal = uniqueQ[i];
        let originalVal = qVal / 10.0;

        // ensure minimum gap from previous level
        let spread = (last === -Infinity) ? originalVal : Math.max(originalVal, last + min_level_gap);

        stemMap.set(qVal, spread);
        last = spread;
    }

    function qKey(v) { return Math.round(v * 10.0); }

    function getStemX(u) {
        let val = rawStems[u];
        return stemMap.get(qKey(val));
    }

    // 2. generate points and links

    const MAX_POINTS = count * 4;

    // structure of arrays (matches binary format)
    let outX = new Float32Array(MAX_POINTS);
    let outY = new Float32Array(MAX_POINTS);
    let outSize = new Float32Array(MAX_POINTS);
    let outR = new Float32Array(MAX_POINTS);
    let outG = new Float32Array(MAX_POINTS);
    let outB = new Float32Array(MAX_POINTS);

    // labels storage
    let outLabels = new Array(MAX_POINTS).fill("");

    let outLinkSrc = new Uint32Array(MAX_POINTS * 2);
    let outLinkTgt = new Uint32Array(MAX_POINTS * 2);

    let pCount = 0;
    let lCount = 0;

    // map logical node index to visual point index
    let nodeToPoint = new Int32Array(count);

    // helper to add point
    function addPoint(x, y, size, rgb, label) {
        if (pCount >= MAX_POINTS) return -1; // should resize
        let id = pCount++;
        outX[id] = x;
        outY[id] = y;
        outSize[id] = size;
        outR[id] = rgb[0];
        outG[id] = rgb[1];
        outB[id] = rgb[2];
        if (label) outLabels[id] = label;
        return id;
    }

    function addLink(s, t) {
        if (lCount >= outLinkSrc.length) return;
        outLinkSrc[lCount] = s;
        outLinkTgt[lCount] = t;
        lCount++;
    }

    // a. create visual nodes for logical nodes
    for (let u = 0; u < count; u++) {
        let isLeaf = (children[u].length === 0);
        let label = names[u];

        let ex = getStemX(u);
        let px = ex - parent_stub; // the 'node' is before the vertical drop

        let size = isLeaf ? SIZE_LEAF_REAL : SIZE_INTERNAL;
        let color = isLeaf ? COLOR_LEAF : COLOR_INTERNAL;

        // logical node ID -> visual point ID
        nodeToPoint[u] = addPoint(px, y[u], size, color, label);
    }

    if (onProgress) onProgress(0.7);

    // b. create edges (orthogonal with bends)
    for (let u = 0; u < count; u++) {
        let kids = children[u];
        if (kids.length === 0) continue;

        let ex = getStemX(u);
        let py = y[u];
        let uPid = nodeToPoint[u];



        for (let v of kids) {
            let cy = y[v];
            let vPid = nodeToPoint[v];

            // adjust child X: parentStem -> spread -> horizontal -> child

            let true_len_px = Math.max(0, blens[v]) * x_scale;
            let finalChildX = ex + weighted_stub + true_len_px;

            // move the child point
            outX[vPid] = finalChildX;

            // bends
            // 1. top elbow (ex, py)
            let elbowTop = addPoint(ex, py, SIZE_BEND, COLOR_BEND, "");
            addLink(uPid, elbowTop);

            if (Math.abs(py - cy) > 1e-5) {
                // 2. bottom elbow (ex, cy)
                let elbowBot = addPoint(ex, cy, SIZE_BEND, COLOR_BEND, "");
                addLink(elbowTop, elbowBot);
                addLink(elbowBot, vPid);
            } else {
                addLink(elbowTop, vPid);
            }
        }
    }

    if (onProgress) onProgress(0.9);

    // c. leaf markers
    let maxLeafX = 0;
    // we iterate points that are leaves
    for (let i = 0; i < count; i++) {
        if (children[i].length === 0) {
            let pid = nodeToPoint[i];
            if (outX[pid] > maxLeafX) maxLeafX = outX[pid];
        }
    }
    let tipLineX = maxLeafX + tip_pad;

    for (let i = 0; i < count; i++) {
        if (children[i].length === 0) {
            let pid = nodeToPoint[i];
            let lbl = outLabels[pid];

            // create marker
            let mPid = addPoint(tipLineX, outY[pid], SIZE_LEAF_MARKER, COLOR_LEAF, lbl);
            addLink(mPid, pid);
        }
    }

    if (onProgress) onProgress(1.0);

    // trim arrays
    return {
        nodeCount: pCount,
        linkCount: lCount,
        x: outX.subarray(0, pCount),
        y: outY.subarray(0, pCount),
        size: outSize.subarray(0, pCount),
        r: outR.subarray(0, pCount),
        g: outG.subarray(0, pCount),
        b: outB.subarray(0, pCount),
        labels: outLabels.slice(0, pCount),
        linkSrc: outLinkSrc.subarray(0, lCount),
        linkTgt: outLinkTgt.subarray(0, lCount)
    };
}
