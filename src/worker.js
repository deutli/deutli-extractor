import { parseBuffer } from './parser.js';

self.onmessage = async (e) => {
    const { id, buffer } = e.data;
    try {
        const parsedData = parseBuffer(buffer);
        self.postMessage({ id, parsedData, error: null });
    } catch (err) {
        self.postMessage({ id, parsedData: null, error: err.toString() });
    }
};
