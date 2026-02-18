/**
 * search.worker.js
 * Handles search operations for massive datasets off the main thread.
 */

let labels = [];

self.onmessage = function (e) {
    const { type } = e.data;

    if (type === 'INIT') {
        // e.data.labels should be the array of strings
        if (e.data.labels) {
            labels = e.data.labels;
            console.log(`[Worker] Loaded ${labels.length} labels.`);
        }
    }
    else if (type === 'SEARCH') {
        const { query, isRegex, limit } = e.data;
        const results = [];
        const maxResults = limit || 50;

        if (!query || query.length === 0) {
            self.postMessage({ type: 'RESULTS', results: [] });
            return;
        }

        try {
            let matches = 0;

            // Regex Search
            if (isRegex) {
                const regex = new RegExp(query, 'i'); // Case-insensitive by default
                for (let i = 0; i < labels.length; i++) {
                    if (regex.test(labels[i])) {
                        results.push({ index: i, label: labels[i] });
                        matches++;
                        if (matches >= maxResults) break;
                    }
                }
            }
            // Substring Search (Faster)
            else {
                const lowerQuery = query.toLowerCase();
                for (let i = 0; i < labels.length; i++) {
                    // Check if label exists to avoid crash on dirty data
                    if (labels[i] && labels[i].toLowerCase().includes(lowerQuery)) {
                        results.push({ index: i, label: labels[i] });
                        matches++;
                        if (matches >= maxResults) break;
                    }
                }
            }
        } catch (err) {
            console.error("[Worker] Search Error", err);
            // Optionally send error back
            self.postMessage({ type: 'ERROR', message: err.message });
            return;
        }

        self.postMessage({ type: 'RESULTS', results });
    }
};
