const worker = new Worker('worker.js', { type: 'module' });

let messageIdCounter = 0;
const workerResolvers = new Map();

worker.onmessage = (e) => {
    const { id, parsedData, error } = e.data;
    if (workerResolvers.has(id)) {
        const { resolve, reject } = workerResolvers.get(id);
        workerResolvers.delete(id);
        if (error) {
            reject(new Error(error));
        } else {
            resolve(parsedData);
        }
    }
};

function parseBufferAsync(buffer) {
    return new Promise((resolve, reject) => {
        const id = messageIdCounter++;
        workerResolvers.set(id, { resolve, reject });
        worker.postMessage({ id, buffer });
    });
}

// Sub-components
const btnSelectFolder = document.getElementById('btn-select-folder');
const outputLog = document.getElementById('output-log');
const folderNameDisplay = document.getElementById('folder-name-display');
const dashboardNav = document.getElementById('dashboard-nav');

const btnGrid = document.getElementById('btn-grid');
const btnList = document.getElementById('btn-list');
const btnBatch = document.getElementById('btn-batch');
const btnReset = document.getElementById('btn-reset');

const viewGrid = document.getElementById('view-grid');
const viewList = document.getElementById('view-list');
const viewBatch = document.getElementById('view-batch');
const inspectorContainer = document.getElementById('inspector-container');

// State
let currentFiles = [];
let globalBasePath = ''; // For Tauri
let currentFolderName = '';
let webDirectoryHandle = null;

// Routing check for Tauri vs Web environment
const isTauri = window.__TAURI_INTERNALS__ !== undefined || window.__TAURI__ !== undefined;

/**
 * Helper function to flatten/simplify metadata from parsed A1111 or ComfyUI objects.
 */
function traceText(nodeId, comfyNodes, visited = new Set()) {
    if (visited.has(nodeId)) return '';
    visited.add(nodeId);
    
    const node = comfyNodes[nodeId];
    if (!node) return '';
    
    if (node.class_type && node.class_type.includes('CLIPTextEncode') && node.inputs && typeof node.inputs.text === 'string') {
        return node.inputs.text.trim();
    }
    
    let chunks = [];
    if (node.inputs) {
        for (const [key, value] of Object.entries(node.inputs)) {
            if (Array.isArray(value) && value.length >= 1) {
                const targetNodeId = String(value[0]);
                const res = traceText(targetNodeId, comfyNodes, visited);
                if (res) chunks.push(res);
            }
        }
    }
    return chunks.join(', ');
}

function traceModel(nodeId, comfyNodes, visited = new Set()) {
    if (visited.has(nodeId)) return '';
    visited.add(nodeId);
    
    const node = comfyNodes[nodeId];
    if (!node) return '';
    
    if (node.inputs && typeof node.inputs.ckpt_name === 'string') {
        return node.inputs.ckpt_name.trim();
    }
    
    if (node.inputs) {
        for (const [key, value] of Object.entries(node.inputs)) {
            if (Array.isArray(value) && value.length >= 1) {
                const targetNodeId = String(value[0]);
                const res = traceModel(targetNodeId, comfyNodes, visited);
                if (res) return res;
            }
        }
    }
    return '';
}

function mapMetadata(parsedData) {
    let result = { 
        prompt: '', negative: '', seed: '', model: '',
        steps: null, cfg: null, sampler_name: null, scheduler: null, denoise: null,
        width: parsedData?.dimensions?.width || null,
        height: parsedData?.dimensions?.height || null
    };
    
    if (parsedData.a1111) {
        result.prompt = parsedData.a1111.prompt || '';
        result.negative = parsedData.a1111.negative || '';
        result.seed = parsedData.a1111.params?.Seed || '';
        result.model = parsedData.a1111.params?.Model || '';
        result.steps = parsedData.a1111.params?.Steps || null;
        result.cfg = parsedData.a1111.params?.['CFG scale'] || null;
        result.sampler_name = parsedData.a1111.params?.Sampler || null;
        result.scheduler = parsedData.a1111.params?.Schedule || null;
        result.denoise = parsedData.a1111.params?.['Denoising strength'] || null;
    } else if (parsedData.comfyUI) {
        const nodes = parsedData.comfyUI;
        const nodesList = Object.keys(nodes).map(k => ({ id: Number(k), ...nodes[k] }));
        
        let targetKSampler = null;
        const saveNodes = nodesList.filter(n => n.class_type === 'SaveImage').sort((a,b) => b.id - a.id);
        
        if (saveNodes.length > 0) {
            const finalSaveNode = saveNodes[0];
            if (finalSaveNode.inputs && Array.isArray(finalSaveNode.inputs.images)) {
                const vaeId = String(finalSaveNode.inputs.images[0]);
                const vaeNode = nodes[vaeId];
                if (vaeNode && vaeNode.inputs && Array.isArray(vaeNode.inputs.samples)) {
                    const samplerId = String(vaeNode.inputs.samples[0]);
                    targetKSampler = nodes[samplerId];
                }
            }
        }
        
        if (!targetKSampler) {
            targetKSampler = nodesList.find(n => n.class_type && n.class_type.includes('KSampler'));
        }
        
        if (targetKSampler && targetKSampler.inputs) {
            result.seed = targetKSampler.inputs.seed !== undefined ? String(targetKSampler.inputs.seed) : '';
            result.steps = targetKSampler.inputs.steps || null;
            result.cfg = targetKSampler.inputs.cfg || null;
            result.sampler_name = targetKSampler.inputs.sampler_name || null;
            result.scheduler = targetKSampler.inputs.scheduler || null;
            result.denoise = targetKSampler.inputs.denoise || null;
            
            const posRef = targetKSampler.inputs.positive;
            const negRef = targetKSampler.inputs.negative;
            const modelRef = targetKSampler.inputs.model;
            
            if (posRef && Array.isArray(posRef)) {
                result.prompt = traceText(String(posRef[0]), nodes);
            }
            if (negRef && Array.isArray(negRef)) {
                result.negative = traceText(String(negRef[0]), nodes);
            }
            if (modelRef && Array.isArray(modelRef)) {
                result.model = traceModel(String(modelRef[0]), nodes);
            }
        }
        
        if (!result.model) {
            const ckptFallback = nodesList.find(n => n.class_type && n.class_type.includes('CheckpointLoader'));
            if (ckptFallback && ckptFallback.inputs) {
                result.model = ckptFallback.inputs.ckpt_name || '';
            }
        }
    }
    return result;
}

/**
 * Generates a DEUTLI Open Asset Format v1.1 compliant .deut JSON payload.
 * 
 * Extractor acts as a migration bridge: the original monolithic prompt is
 * preserved in llm_output.legacy_prompt. input_dna text fields are stubbed
 * with empty strings for future manual completion by the user.
 * 
 * fingerprint = 64 zeros (import placeholder — real hash impossible without userId).
 */
function generateDeutPayload(filename, mapped, parsedData) {
    // --- Aspect Ratio ---
    let aspectRatio = '';
    if (mapped.width && mapped.height) {
        aspectRatio = `${mapped.width}:${mapped.height}`;
    }

    // --- Detect source ---
    const source = parsedData.comfyUI ? 'comfyUI' : (parsedData.a1111 ? 'a1111' : 'unknown');

    // --- vendor_data: all raw technical params ---
    const rawParams = {};
    if (mapped.model)        rawParams.model        = mapped.model;
    if (mapped.steps)        rawParams.steps        = mapped.steps;
    if (mapped.cfg)          rawParams.cfg          = mapped.cfg;
    if (mapped.sampler_name) rawParams.sampler_name = mapped.sampler_name;
    if (mapped.scheduler)    rawParams.scheduler    = mapped.scheduler;
    if (mapped.denoise)      rawParams.denoise      = mapped.denoise;
    if (mapped.width)        rawParams.width        = mapped.width;
    if (mapped.height)       rawParams.height       = mapped.height;

    // Attach full raw graph / metadata for lossless preservation
    if (parsedData.comfyUI)       rawParams.comfy_graph    = parsedData.comfyUI;
    if (parsedData.a1111)         rawParams.a1111_params   = parsedData.a1111.params;
    if (parsedData.rawMetadata)   rawParams.raw_metadata   = parsedData.rawMetadata;

    const payload = {
        meta: {
            version: "1.1",
            userId: "local-user",
            label: filename.replace(/\.[^/.]+$/, '')
        },
        input_dna: {
            text_fields: {
                subject: "",
                action: "",
                environment: "",
                atmosphere: ""
            },
            selectors: {},
            technical: {
                aspectRatio: aspectRatio,
                seed: mapped.seed || "",
                avoid: mapped.negative || ""
            }
        },
        llm_output: {
            legacy_prompt: mapped.prompt || ""
        },
        vendor_data: {
            extractor_source: source,
            raw_params: rawParams
        },
        fingerprint: "0000000000000000000000000000000000000000000000000000000000000000"
    };

    return JSON.stringify(payload, null, 2);
}

/**
 * Saves content to a .deut file.
 */
async function saveDeutFile(originalFilename, fileContent) {
    const outputFilename = originalFilename + '.deut';
    
    if (isTauri) {
        const { writeTextFile } = await import('@tauri-apps/plugin-fs');
        const { join } = await import('@tauri-apps/api/path');
        const outputPath = await join(globalBasePath, outputFilename);
        await writeTextFile(outputPath, fileContent);
        return outputPath;
    } else {
        if (!webDirectoryHandle) {
            webDirectoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        }
        const fileHandle = await webDirectoryHandle.getFileHandle(outputFilename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(fileContent);
        await writable.close();
        return outputFilename;
    }
}

/**
 * Renders the right-side inspector pane.
 */
function renderInspector(imgSrc, parsedData, fileName) {
    const mapped = mapMetadata(parsedData);
    
    let html = `
    <div style="display: flex; gap: 24px; align-items: flex-start; margin-bottom: 32px; flex-wrap: wrap;">
        <img id="inspector-image" src="${imgSrc}" style="flex: 1; min-width: 200px; max-width: 400px; max-height: 40vh; object-fit: contain; display: block; border-radius: 4px; border: 1px solid var(--color-dark-grey-border); background-color: var(--color-void-black);" alt="${fileName}">
        <div style="display: flex; flex-direction: column; flex: 1; min-width: 250px; gap: 16px;">
            <div class="font-archivo text-section-header" style="word-break: break-all; margin-bottom: 8px;">${fileName}</div>
            <button id="btn-save-deut" class="btn-micro-rounded btn-primary" style="padding: 16px; font-weight: bold; font-family: var(--font-manrope); text-transform: uppercase; width: 100%; text-align: center; font-size: 16px;">
                Save Metadata to .deut
            </button>
        </div>
    </div>
    <div class="font-archivo text-section-header" style="margin-bottom: 24px;">Metadata Inspector</div>
    `;
    
    const textFields = [
        { key: 'prompt', label: 'Prompt' },
        { key: 'negative', label: 'Negative Prompt' }
    ];

    const techFields = [
        { key: 'model', label: 'Model' },
        { key: 'seed', label: 'Seed' },
        { key: 'steps', label: 'Steps' },
        { key: 'cfg', label: 'CFG' },
        { key: 'sampler_name', label: 'Sampler' },
        { key: 'scheduler', label: 'Scheduler' },
        { key: 'denoise', label: 'Denoise' },
        { key: 'width', label: 'Width' },
        { key: 'height', label: 'Height' }
    ];

    let hasData = !!(mapped.prompt || mapped.negative || mapped.model || mapped.seed);
    
    // Render text areas for Prompt and Negative Prompt
    textFields.forEach(f => {
        const val = mapped[f.key] || '';
        html += `
        <div style="margin-bottom: 16px;">
            <div class="text-micro-label" style="margin-bottom: 8px;">${f.label}</div>
            <div class="text-input-value" style="width: 100%; min-height: 48px; background: var(--color-void-black); color: var(--color-soft-grey); border: 1px solid var(--color-dark-grey-border); padding: 12px; border-radius: 4px; box-sizing: border-box; line-height: 1.5; font-family: var(--font-manrope); font-size: 14px; word-break: break-word; white-space: pre-wrap; cursor: text; user-select: text;">${val}</div>
        </div>`;
    });
    
    // Render technical fields in a table structure
    let tableRows = '';
    techFields.forEach(f => {
        const val = mapped[f.key];
        if (val !== undefined && val !== null && val !== '') {
            tableRows += `
            <div style="display: flex; border-bottom: 1px solid var(--color-dark-grey-border); padding: 8px 0; align-items: center;">
                <div class="text-micro-label" style="width: 100px; color: var(--color-muted-grey); margin: 0;">${f.label}</div>
                <input type="text" readonly class="text-input-value" value="${val}" style="flex: 1; background: transparent; color: var(--color-soft-grey); border: none; padding: 0; margin: 0; box-sizing: border-box; font-family: var(--font-manrope); font-size: 14px; outline: none;">
            </div>`;
        }
    });

    if (tableRows) {
        html += `
        <div style="margin-bottom: 16px;">
            <div class="text-micro-label" style="margin-bottom: 8px;">Technical Stats</div>
            <div style="background: var(--color-void-black); border: 1px solid var(--color-dark-grey-border); border-radius: 4px; padding: 0 12px;">
                ${tableRows}
            </div>
        </div>`;
    }
    
    if (!hasData) {
        html += `<div style="white-space: pre-wrap; word-break: break-word; background: var(--color-void-black); color: var(--color-muted-grey); border: 1px dashed var(--color-dark-grey-border); padding: 12px; border-radius: 4px; margin-top: 16px; font-family: var(--font-manrope); font-size: 14px;">Warning: No recognizable structured AI metadata found.</div>`;
    }

    if (parsedData && (parsedData.comfyUI || parsedData.a1111)) {
        html += `
        <button id="btn-copy-raw" class="btn-micro-rounded" style="width: 100%; padding: 10px; margin-top: 16px; margin-bottom: 24px; font-family: var(--font-manrope); font-size: 12px; font-weight: bold; color: var(--color-paper-white); border: 1px solid var(--color-dark-grey-border); border-radius: 4px; background: transparent; cursor: pointer; transition: all 0.2s;">
            COPY RAW WORKFLOW
        </button>
        `;
    }

    inspectorContainer.innerHTML = html;
    
    // Add event listener for the copy request
    const btnCopy = document.getElementById('btn-copy-raw');
    if (btnCopy) {
        btnCopy.addEventListener('click', async () => {
            const dataToCopy = parsedData.comfyUI ? JSON.stringify(parsedData.comfyUI, null, 2) : JSON.stringify(parsedData.rawMetadata || parsedData.a1111, null, 2);
            try {
                await navigator.clipboard.writeText(dataToCopy);
                const oldText = btnCopy.textContent;
                btnCopy.textContent = "COPIED TO CLIPBOARD!";
                btnCopy.style.borderColor = "var(--color-hyper-yellow)";
                btnCopy.style.color = "var(--color-hyper-yellow)";
                setTimeout(() => {
                    btnCopy.textContent = oldText;
                    btnCopy.style.borderColor = "var(--color-dark-grey-border)";
                    btnCopy.style.color = "var(--color-paper-white)";
                }, 2000);
            } catch (err) {
                console.error("Failed to copy", err);
            }
        });
    }

    document.getElementById('btn-save-deut').addEventListener('click', async () => {
        try {
            outputLog.textContent = `Saving ${fileName}.deut...`;
            const payload = generateDeutPayload(fileName, mapped, parsedData);
            await saveDeutFile(fileName, payload);
            outputLog.textContent = `Successfully saved ${fileName}.deut`;
            alert(`Saved ${fileName}.deut successfully!`);
        } catch (err) {
            outputLog.textContent = `Save error: ${err}`;
            console.error(err);
        }
    });
}

// -------------------------------------------------------------
// Routing Implementation
// -------------------------------------------------------------

function switchView(viewName) {
    viewGrid.style.display = 'none';
    viewList.style.display = 'none';
    viewBatch.style.display = 'none';
    inspectorContainer.style.display = 'none';
    
    if (viewName === 'grid') {
        viewGrid.style.display = 'block';
        inspectorContainer.style.display = 'block';
        renderGrid();
    } else if (viewName === 'list') {
        viewList.style.display = 'block';
        inspectorContainer.style.display = 'block';
        renderList();
    } else if (viewName === 'batch') {
        // Inspector remains hidden for batch view as requested.
        startBatch();
    }
}

let lazyObserver = null;
function getGridObserver() {
    if (lazyObserver) lazyObserver.disconnect();
    lazyObserver = new IntersectionObserver((entries, obs) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const img = entry.target;
                if (img._lazyLoad) {
                    img._lazyLoad();
                }
                obs.unobserve(img);
            }
        });
    }, {
        root: viewGrid
    });
    return lazyObserver;
}

function releaseObjectUrls(container) {
    const existingImages = container.querySelectorAll('img');
    existingImages.forEach(img => {
        if (img.src && img.src.startsWith('blob:')) {
            URL.revokeObjectURL(img.src);
        }
    });
}

function renderGrid() {
    releaseObjectUrls(viewGrid);
    viewGrid.innerHTML = '';
    
    const gridInner = document.createElement('div');
    gridInner.style.display = 'flex';
    gridInner.style.flexWrap = 'wrap';
    gridInner.style.gap = '10px';
    
    const obs = getGridObserver();
    const fragment = document.createDocumentFragment();
    
    for (const item of currentFiles) {
        const img = document.createElement('img');
        img.style.width = '150px';
        img.style.height = '150px';
        img.style.backgroundColor = '#333';
        img.style.display = 'inline-block';
        
        if (isTauri) {
            const entry = item;
            img.title = entry.name;
            const fullPath = globalBasePath + entry.name;
            
            img._lazyLoad = async () => {
                const { convertFileSrc } = await import('@tauri-apps/api/core');
                const assetUrl = convertFileSrc(fullPath);
                img.src = assetUrl;
                img.style.backgroundColor = 'transparent';
                img.style.cursor = 'pointer';
                
                img.addEventListener('click', async () => {
                    outputLog.textContent = `Inspecting ${entry.name}...`;
                    inspectorContainer.innerHTML = '<p>Loading...</p>';
                    try {
                        const { readFile } = await import('@tauri-apps/plugin-fs');
                        const uint8Array = await readFile(fullPath);
                        const parsedData = await parseBufferAsync(uint8Array);
                        renderInspector(assetUrl, parsedData, entry.name);
                        outputLog.textContent = `Focus mode active: ${entry.name}`;
                    } catch (err) {
                        outputLog.textContent = `Error reading file: ${err}`;
                        inspectorContainer.innerHTML = `<p style="color: red;">Error: ${err}</p>`;
                    }
                });
            };
        } else {
            const file = item;
            img.title = file.name;
            
            img._lazyLoad = () => {
                const objectUrl = URL.createObjectURL(file);
                img.src = objectUrl;
                img.style.backgroundColor = 'transparent';
                img.style.cursor = 'pointer';
                
                img.addEventListener('click', async () => {
                    outputLog.textContent = `Inspecting ${file.name}...`;
                    inspectorContainer.innerHTML = '<p>Loading...</p>';
                    try {
                        const buffer = await file.arrayBuffer();
                        const parsedData = await parseBufferAsync(buffer);
                        renderInspector(objectUrl, parsedData, file.name);
                        outputLog.textContent = `Focus mode active: ${file.name}`;
                    } catch (err) {
                        outputLog.textContent = `Error reading file: ${err}`;
                        inspectorContainer.innerHTML = `<p style="color: red;">Error: ${err}</p>`;
                    }
                });
            };
        }
        
        fragment.appendChild(img);
        obs.observe(img);
    }
    
    gridInner.appendChild(fragment);
    viewGrid.appendChild(gridInner);
    outputLog.textContent = 'Grid view constructed.';
    inspectorContainer.innerHTML = '<p style="color: #888;">Select an item to inspect metadata.</p>';
}

function renderList() {
    viewList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    
    for (const item of currentFiles) {
        const div = document.createElement('div');
        const name = isTauri ? item.name : item.name;
        
        div.style.padding = '12px 8px';
        div.style.borderBottom = '1px solid var(--color-dark-grey-border)';
        div.style.cursor = 'pointer';
        div.style.display = 'flex';
        div.style.justifyContent = 'space-between';
        div.style.alignItems = 'center';
        div.style.gap = '16px';
        
        div.addEventListener('mouseenter', () => div.style.backgroundColor = 'rgba(255, 255, 255, 0.05)');
        div.addEventListener('mouseleave', () => div.style.backgroundColor = 'transparent');
        
        let dateHtml = `<div class="file-date" style="font-family: var(--font-manrope); font-size: 12px; color: var(--color-muted-grey); white-space: nowrap; text-align: right;">...</div>`;
        
        if (!isTauri) {
            const d = new Date(item.lastModified);
            const dateStr = d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            dateHtml = `<div class="file-date" style="font-family: var(--font-manrope); font-size: 12px; color: var(--color-muted-grey); white-space: nowrap; text-align: right;">${dateStr}</div>`;
        }
        
        div.innerHTML = `
            <div style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-manrope); font-size: 14px; color: var(--color-paper-white);">${name}</div>
            ${dateHtml}
        `;
        
        if (isTauri) {
            import('@tauri-apps/plugin-fs').then(({ stat }) => {
                stat(globalBasePath + name).then(fileInfo => {
                    if (fileInfo.mtime || fileInfo.birthtime) {
                        const d = new Date(fileInfo.mtime || fileInfo.birthtime);
                        const dateEl = div.querySelector('.file-date');
                        if (dateEl) dateEl.textContent = d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                    }
                }).catch(() => {});
            });
        }
        
        div.addEventListener('click', async () => {
            outputLog.textContent = `Inspecting ${name}...`;
            inspectorContainer.innerHTML = '<p>Loading...</p>';
            try {
                if (isTauri) {
                    const { readFile } = await import('@tauri-apps/plugin-fs');
                    const { convertFileSrc } = await import('@tauri-apps/api/core');
                    const fullPath = globalBasePath + name;
                    const uint8Array = await readFile(fullPath);
                    const parsedData = await parseBufferAsync(uint8Array);
                    renderInspector(convertFileSrc(fullPath), parsedData, name);
                } else {
                    const buffer = await item.arrayBuffer();
                    const parsedData = await parseBufferAsync(buffer);
                    const objectUrl = URL.createObjectURL(item);
                    renderInspector(objectUrl, parsedData, name);
                }
                outputLog.textContent = `Focus mode active: ${name}`;
            } catch (err) {
                outputLog.textContent = `Error reading file: ${err}`;
                inspectorContainer.innerHTML = `<p style="color: red;">Error: ${err}</p>`;
            }
        });
        fragment.appendChild(div);
    }
    
    viewList.appendChild(fragment);
    outputLog.textContent = 'List view constructed.';
    inspectorContainer.innerHTML = '<p style="color: #888;">Select an item to inspect metadata.</p>';
}

async function startBatch() {
    viewGrid.style.display = 'none';
    viewList.style.display = 'none';
    inspectorContainer.style.display = 'none';
    viewBatch.style.display = 'block';
    
    viewBatch.innerHTML = `
        <div class="font-archivo text-section-header" style="margin-bottom: 24px;">Batch Processing ${currentFiles.length} files</div>
        <div id="batch-progress" style="white-space: pre-wrap; font-family: var(--font-manrope); color: var(--color-paper-white); font-size: 14px; background: var(--color-void-black); border: 1px solid var(--color-dark-grey-border); border-radius: 4px; padding: 16px;">Requesting directory access...</div>
    `;

    const progressDiv = document.getElementById('batch-progress');
    const total = currentFiles.length;
    let successCount = 0;
    let failCount = 0;
    
    if (!isTauri && !webDirectoryHandle) {
        try {
            webDirectoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        } catch (err) {
            progressDiv.textContent = `Batch cancelled. Directory access required to save .deut files into the same folder.\nError: ${err}`;
            return;
        }
    }
    
    let tauriReadFile = null;
    if (isTauri) {
        const { readFile } = await import('@tauri-apps/plugin-fs');
        tauriReadFile = readFile;
    }

    progressDiv.textContent = `Starting extraction for ${total} files...\n`;
    
    for (let i = 0; i < total; i++) {
        const item = currentFiles[i];
        const name = isTauri ? item.name : item.name;
        
        progressDiv.textContent = `Processing ${i + 1} / ${total}...\nFile: ${name}`;
        
        try {
            let parsedData;
            if (isTauri) {
                const fullPath = globalBasePath + name;
                const uint8Array = await tauriReadFile(fullPath);
                parsedData = await parseBufferAsync(uint8Array);
            } else {
                const buffer = await item.arrayBuffer();
                parsedData = await parseBufferAsync(buffer);
            }
            
            const mapped = mapMetadata(parsedData);
            const payload = generateDeutPayload(name, mapped, parsedData);
            await saveDeutFile(name, payload);
            successCount++;
        } catch(err) {
            failCount++;
            console.error(`Error processing ${name}:`, err);
        }
    }
    
    progressDiv.innerHTML = `<strong>Finished!</strong><br>Successfully saved: ${successCount}<br>Failed: ${failCount}`;
    outputLog.innerHTML = `<span style="color: var(--color-hyper-yellow);">Batch extraction complete: ${successCount}/${total} saved.</span>`;
}

// -------------------------------------------------------------
// Header Setup & Events
// -------------------------------------------------------------

function resetApp() {
    releaseObjectUrls(viewGrid);

    viewGrid.innerHTML = '';
    viewList.innerHTML = '';
    inspectorContainer.innerHTML = '<p style="color: #888;">Select an item to inspect metadata.</p>';
    viewBatch.innerHTML = '';

    currentFiles = [];
    currentFolderName = '';
    webDirectoryHandle = null;

    folderNameDisplay.style.display = 'none';
    dashboardNav.style.display = 'none';
    btnReset.style.display = 'none';
    
    btnSelectFolder.style.display = 'inline-block';
    
    viewGrid.style.display = 'none';
    viewList.style.display = 'none';
    viewBatch.style.display = 'none';
    inspectorContainer.style.display = 'none';
    
    outputLog.textContent = 'App reset. Ready for a new folder.';
}

function onFolderParsed() {
    btnSelectFolder.style.display = 'none';
    
    folderNameDisplay.textContent = currentFolderName;
    folderNameDisplay.style.display = 'inline-block';
    
    dashboardNav.style.display = 'flex';
    btnReset.style.display = 'inline-block';
    
    viewGrid.style.display = 'none';
    viewList.style.display = 'none';
    viewBatch.style.display = 'none';
    inspectorContainer.style.display = 'none';
    
    outputLog.innerHTML = `<span style="color: var(--color-paper-white);">${currentFiles.length} PNGs ready for processing.<br>Choose a view or run the extractor.</span>`;
}

btnGrid.addEventListener('click', () => switchView('grid'));
btnList.addEventListener('click', () => switchView('list'));
btnBatch.addEventListener('click', () => switchView('batch'));
btnReset.addEventListener('click', resetApp);

btnSelectFolder.addEventListener('click', async () => {
    currentFiles = [];
    outputLog.textContent = '';
    
    if (isTauri) {
        try {
            outputLog.textContent = 'Opening native dialog...';
            const { open } = await import('@tauri-apps/plugin-dialog');
            const { readDir } = await import('@tauri-apps/plugin-fs');
            
            const selectedPath = await open({
                directory: true,
                multiple: false
            });

            if (selectedPath) {
                outputLog.textContent = `Scanning: ${selectedPath}`;
                const entries = await readDir(selectedPath);
                
                const separator = selectedPath.includes('\\') ? '\\' : '/';
                globalBasePath = selectedPath.endsWith(separator) ? selectedPath : selectedPath + separator;

                for (const entry of entries) {
                    if (entry.isFile && entry.name && entry.name.toLowerCase().endsWith('.png')) {
                        currentFiles.push(entry);
                    }
                }
                
                currentFolderName = selectedPath;
                onFolderParsed();
            } else {
                outputLog.textContent = 'Selection canceled.';
            }
        } catch (err) {
            outputLog.textContent = `Tauri Error: ${err}`;
        }
    } else {
        if ('showDirectoryPicker' in window) {
            try {
                webDirectoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
                for await (const entry of webDirectoryHandle.values()) {
                    if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.png')) {
                        const file = await entry.getFile();
                        currentFiles.push(file);
                    }
                }
                currentFolderName = webDirectoryHandle.name;
                
                if (currentFiles.length > 0) {
                    onFolderParsed();
                } else {
                    outputLog.textContent = 'No PNG files found in selected folder.';
                }
            } catch (err) {
                if (err.name === 'AbortError') {
                    outputLog.textContent = 'Selection canceled.';
                } else {
                    outputLog.textContent = 'Directory access error: ' + err;
                }
            }
        } else {
            const input = document.createElement('input');
            input.type = 'file';
            input.webkitdirectory = true;
            input.multiple = true;
            
            input.addEventListener('change', (e) => {
                const files = e.target.files;
                if (files && files.length > 0) {
                    for (let i = 0; i < files.length; i++) {
                        const file = files[i];
                        const slashParts = file.webkitRelativePath.split('/');
                        if (slashParts.length > 2) continue;
                        
                        if (file.name.toLowerCase().endsWith('.png')) {
                            currentFiles.push(file);
                        }
                    }
                    
                    if (currentFiles.length > 0) {
                        const slashParts = currentFiles[0].webkitRelativePath.split('/');
                        currentFolderName = slashParts[0] || 'Selected Folder';
                    }
                    
                    onFolderParsed();
                } else {
                    outputLog.textContent = 'No files selected.';
                }
            });
            input.click();
        }
    }
});

// -------------------------------------------------------------
// Theme Switcher Logic
// -------------------------------------------------------------
const THEME_KEY = 'deutli-theme';

function applyTheme(theme) {
    if (theme === 'system') {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.body.classList.toggle('theme-dark', isDark);
        document.body.classList.toggle('dark', isDark);
    } else {
        const isDark = theme === 'dark';
        document.body.classList.toggle('theme-dark', isDark);
        document.body.classList.toggle('dark', isDark);
    }
    localStorage.setItem(THEME_KEY, theme);
}

// Initial theme hook
const savedTheme = localStorage.getItem(THEME_KEY) || 'dark';
applyTheme(savedTheme);

document.getElementById('btn-theme-switcher')?.addEventListener('click', () => {
    const cur = localStorage.getItem(THEME_KEY) || 'dark';
    applyTheme(cur === 'dark' ? 'light' : 'dark');
});

// -------------------------------------------------------------
// Help Modal Logic
// -------------------------------------------------------------
const btnHelp = document.getElementById('btn-help');
const helpModal = document.getElementById('help-modal');
const btnCloseHelp = document.getElementById('close-help');

if (btnHelp && helpModal && btnCloseHelp) {
    btnHelp.addEventListener('click', () => {
        helpModal.showModal();
    });

    btnCloseHelp.addEventListener('click', () => {
        helpModal.close();
    });

    // Close on backdrop click
    helpModal.addEventListener('click', (e) => {
        const rect = helpModal.getBoundingClientRect();
        if (
            e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom
        ) {
            helpModal.close();
        }
    });
}

// -------------------------------------------------------------
// ToS Modal Logic
// -------------------------------------------------------------
const btnHeaderTos = document.getElementById('btn-header-tos');
const tosModal = document.getElementById('tos-modal');
const btnCloseTos = document.getElementById('close-tos');

function openTos() {
    if (tosModal) tosModal.showModal();
}

if (btnHeaderTos) btnHeaderTos.addEventListener('click', openTos);

if (tosModal && btnCloseTos) {
    btnCloseTos.addEventListener('click', () => {
        tosModal.close();
    });

    // Close on backdrop click
    tosModal.addEventListener('click', (e) => {
        const rect = tosModal.getBoundingClientRect();
        if (
            e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom
        ) {
            tosModal.close();
        }
    });
}