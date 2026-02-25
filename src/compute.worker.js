/**
 * Compute worker (module)
 * Handles heavy graph processing off the main thread.
 */

import { parseNewick, computeLayout, buildVisualGraph } from './logic/tree_algo_iterative.js';
import { serializeLabels } from './io/binary_format.js';

self.onmessage = function (e) {
    const { type, payload } = e.data;

    if (type === 'START_JOB') {
        runJob(payload);
    }
};

function runJob(text) {
    try {
        const start = performance.now();
        console.log("[Worker] Starting Job...");

        // 1. parse
        postMessage({ type: 'PROGRESS', stage: 'Parsing Newick...', progress: 0 });
        const tree = parseNewick(text, (p) => {
            postMessage({ type: 'PROGRESS', stage: 'Parsing...', progress: p * 40 }); // 0-40%
        });

        console.log(`[Worker] Parsed ${tree.count} nodes.`);

        // 2. layout
        postMessage({ type: 'PROGRESS', stage: 'Computing Layout...', progress: 40 });
        const layout = computeLayout(tree, (p) => {
            postMessage({ type: 'PROGRESS', stage: 'Layout...', progress: 40 + p * 30 }); // 40-70%
        });

        // 3. visuals
        postMessage({ type: 'PROGRESS', stage: 'Generating Geometry...', progress: 70 });
        const graph = buildVisualGraph(tree, layout, (p) => {
            postMessage({ type: 'PROGRESS', stage: 'Geometry...', progress: 70 + p * 30 }); // 70-100%
        });

        // 4. serialize labels & prepare zero-copy transfer
        postMessage({ type: 'PROGRESS', stage: 'Serializing...', progress: 100 });

        const labelData = serializeLabels(graph.labels);

        // remove original labels to free memory
        graph.labels = null;

        const duration = (performance.now() - start).toFixed(2);
        console.log(`[Worker] Done in ${duration}ms. Nodes: ${graph.nodeCount}.`);

        // prepare transferables
        const transferables = [
            graph.x.buffer,
            graph.y.buffer,
            graph.size.buffer,
            graph.r.buffer,
            graph.g.buffer,
            graph.b.buffer,
            graph.linkSrc.buffer,
            graph.linkTgt.buffer,
            labelData.labelBytes.buffer,
            labelData.labelOffsets.buffer
        ];

        postMessage({
            type: 'COMPLETE',
            result: {
                nodeCount: graph.nodeCount,
                linkCount: graph.linkCount,
                x: graph.x,
                y: graph.y,
                size: graph.size,
                r: graph.r,
                g: graph.g,
                b: graph.b,
                linkSrc: graph.linkSrc,
                linkTgt: graph.linkTgt,
                labelBytes: labelData.labelBytes,
                labelOffsets: labelData.labelOffsets
            }
        }, transferables);

    } catch (err) {
        console.error(err);
        postMessage({ type: 'ERROR', message: err.message });
    }
}
