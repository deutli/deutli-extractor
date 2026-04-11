/**
 * Headless PNG Metadata Parser
 * Extracts A1111 or ComfyUI metadata from PNG buffers.
 */

export function extractPngMetadata(bufferInput) {
    let buffer;
    if (bufferInput instanceof Uint8Array) {
        // Ensure a clean ArrayBuffer from Uint8Array
        buffer = bufferInput.buffer.slice(bufferInput.byteOffset, bufferInput.byteOffset + bufferInput.byteLength);
    } else {
        buffer = bufferInput;
    }

    const view = new DataView(buffer);
    const decoder = new TextDecoder("utf-8");

    // Check PNG Signature
    if (view.getUint32(0) !== 0x89504E47) return null;

    let width = 0;
    let height = 0;
    let metadata = null;
    let comfyPrompt = null;

    let offset = 8;
    while (offset < buffer.byteLength) {
        // Check if we have enough bytes left for length and type
        if (offset + 8 > buffer.byteLength) break;

        const length = view.getUint32(offset);
        const type = decoder.decode(buffer.slice(offset + 4, offset + 8));

        // Ensure we don't read past the buffer if chunk is corrupted
        if (offset + 12 + length > buffer.byteLength) break;

        if (type === 'IHDR') {
            width = view.getUint32(offset + 8);
            height = view.getUint32(offset + 12);
        } else if (type === 'tEXt') {
            const chunkData = buffer.slice(offset + 8, offset + 8 + length);
            const text = decoder.decode(chunkData);
            const splitIndex = text.indexOf('\0');
            if (splitIndex !== -1) {
                const keyword = text.substring(0, splitIndex);
                const content = text.substring(splitIndex + 1);

                if (keyword === 'parameters') {
                    metadata = content;
                } else if (keyword === 'prompt') {
                    comfyPrompt = content;
                }
            }
        } else if (type === 'iTXt') {
            const chunkStart = offset + 8;
            const chunkEnd = offset + 8 + length;
            let cursor = chunkStart;

            while (cursor < chunkEnd && view.getUint8(cursor) !== 0) cursor++;
            const keyword = decoder.decode(buffer.slice(chunkStart, cursor));
            cursor++;

            if (keyword === 'parameters') {
                const compressionFlag = view.getUint8(cursor);
                cursor += 2; // skip flag and method

                if (compressionFlag === 0) {
                    while (cursor < chunkEnd && view.getUint8(cursor) !== 0) cursor++;
                    cursor++; // skip null
                    while (cursor < chunkEnd && view.getUint8(cursor) !== 0) cursor++;
                    cursor++; // skip null

                    const textData = buffer.slice(cursor, chunkEnd);
                    metadata = decoder.decode(textData);
                }
            }
        }

        offset += 12 + length;
    }

    if (!metadata && !comfyPrompt) return { width, height, _no_metadata: true };

    return { metadata, comfyPrompt, width, height };
}

export function extractA1111Data(text) {
    const parts = text.split('\nNegative prompt:');
    let prompt = parts[0] ? parts[0].trim() : '';
    let negative = '';
    let paramsLine = '';

    if (parts.length > 1) {
        const negativeAndParams = parts[1].split('\nSteps:');
        negative = negativeAndParams[0] ? negativeAndParams[0].trim() : '';
        if (negativeAndParams.length > 1) {
            paramsLine = 'Steps:' + negativeAndParams.slice(1).join('\nSteps:');
        }
    } else {
        const promptAndParams = text.split('\nSteps:');
        if (promptAndParams.length > 1) {
            prompt = promptAndParams[0].trim();
            paramsLine = 'Steps:' + promptAndParams.slice(1).join('\nSteps:');
        }
    }

    const params = {};
    if (paramsLine) {
        const items = paramsLine.split(/,\s*(?=\w+:)/);
        items.forEach(item => {
            const [key, ...valueParts] = item.split(':');
            if (key && valueParts.length > 0) {
                params[key.trim()] = valueParts.join(':').trim();
            }
        });
    }

    return { prompt, negative, params };
}

export function parseBuffer(buffer) {
    const raw = extractPngMetadata(buffer);
    if (!raw) return { error: "Invalid PNG file" };

    const result = { dimensions: { width: raw.width, height: raw.height } };
    
    if (raw._no_metadata) {
        result.message = "No AI metadata found (tEXt/iTXt chunks missing or stripped)";
        return result;
    }

    if (raw.comfyPrompt) {
        try {
            result.comfyUI = JSON.parse(raw.comfyPrompt);
        } catch(e) {
            result.comfyUI_raw = raw.comfyPrompt;
        }
    }
    
    if (raw.metadata) {
        result.a1111 = extractA1111Data(raw.metadata);
        result.rawMetadata = raw.metadata;
    }

    return result;
}
