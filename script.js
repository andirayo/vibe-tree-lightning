// --- Configuration & State ---
const canvas = document.getElementById('sim-canvas');
const ctx = canvas.getContext('2d');

const WIDTH = canvas.width;
const HEIGHT = canvas.height;
const TOTAL_PIXELS = WIDTH * HEIGHT;

// Simulation State
let isRunning = false;
let currentDate = new Date();
let lastFrameTime = 0;
let timeAccumulator = 0; // To track simulated days vs real time

// Grid: 1D array for performance (row-major: index = y * WIDTH + x)
// Each cell stores: 0 (Empty), 1 (Tree), 2 (Fire), 3 (Lightning), 4 (Burnt/Ash - optional visual)
// We also need parallel arrays to track "days remaining" for fire/lightning
let grid = new Uint8Array(TOTAL_PIXELS);
let stateTimers = new Uint8Array(TOTAL_PIXELS); // Tracks days remaining for Fire/Lightning

// Cell Type Constants
const EMPTY = 0;
const TREE = 1;
const FIRE = 2;
const LIGHTNING = 3;

// Stats
let stats = {
    lightnings: 0,
    spawned: 0,
    burnt: 0
};

// --- DOM Elements ---
const els = {
    date: document.getElementById('date-display'),
    btnPlay: document.getElementById('play-btn'),
    btnPause: document.getElementById('pause-btn'),
    btnReset: document.getElementById('reset-btn'),
    stats: {
        lightnings: document.getElementById('stat-lightnings'),
        spawned: document.getElementById('stat-spawned'),
        burnt: document.getElementById('stat-burnt')
    },
    params: {
        treesRate: document.getElementById('trees-rate'),
        lightningRate: document.getElementById('lightning-rate'),
        speed: document.getElementById('speed-rate'),
        colorTree: document.getElementById('color-tree'),
        colorLightning: document.getElementById('color-lightning'),
        colorFire: document.getElementById('color-fire')
    }
};

// --- Initialization ---
function init() {
    currentDate = new Date(); // Start "Today"
    resetGrid();
    updateUI();
    render();
}

function resetGrid() {
    grid.fill(EMPTY);
    stateTimers.fill(0);
    stats = { lightnings: 0, spawned: 0, burnt: 0 };
    updateStats();
}

// --- Main Loop ---
function loop(timestamp) {
    if (!lastFrameTime) lastFrameTime = timestamp;
    const deltaTime = (timestamp - lastFrameTime) / 1000; // in seconds
    lastFrameTime = timestamp;

    if (isRunning) {
        const speed = parseFloat(els.params.speed.value) || 1;
        // speed = days per second
        // Check if enough real time has passed to simulate a day
        timeAccumulator += deltaTime * speed;

        while (timeAccumulator >= 1) {
            simulateDay();
            timeAccumulator -= 1;
        }
    }

    render();
    requestAnimationFrame(loop);
}

// --- Simulation Logic ---
function simulateDay() {
    // 1. Advance Date
    currentDate.setDate(currentDate.getDate() + 1);
    updateUI();

    // 2. Spawn Trees
    const treesPerMonth = parseInt(els.params.treesRate.value) || 0;
    // Simple approximation: trees per day = rate / 30
    let treesToSpawn = treesPerMonth / 30;
    // Handle fractional spawning using probability
    const guaranteedTrees = Math.floor(treesToSpawn);
    const fractionalChance = treesToSpawn - guaranteedTrees;
    
    let count = guaranteedTrees + (Math.random() < fractionalChance ? 1 : 0);
    
    for (let i = 0; i < count; i++) {
        spawnTree();
    }

    // 3. Lightning Strikes
    const lightningsPerMonth = parseInt(els.params.lightningRate.value) || 0;
    const lightningChance = lightningsPerMonth / 30; // Chance per day
    
    // Determine number of lightnings (usually 0 or 1, but could be more if rate is high)
    // Using Poisson-ish logic: just check once per day for simplicity based on prompt "if there was a lightning that day"
    // But allowing "numbers of lightnings" implies count. Let's treat it as chance sum.
    let lightningCount = Math.floor(lightningChance) + (Math.random() < (lightningChance % 1) ? 1 : 0);

    for (let i = 0; i < lightningCount; i++) {
        spawnLightning();
    }

    // 4. Update Grid State (Fire spread and decay)
    // We need a next state buffer to avoid cascading updates in same frame
    // For simplicity, we can record changes and apply them after logic
    
    const changes = []; // Stores { index, type, timer }

    for (let i = 0; i < TOTAL_PIXELS; i++) {
        const type = grid[i];
        
        if (type === LIGHTNING) {
            // Lightning lasts 1 day (visual), then disappears
            // If it hit a tree, that logic happened at spawn time
            changes.push({ index: i, type: EMPTY, timer: 0 });
        }
        else if (type === FIRE) {
            // Fire spreads to neighbors
            const x = i % WIDTH;
            const y = Math.floor(i / WIDTH);
            
            // Check 8 neighbors
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    
                    const nx = x + dx;
                    const ny = y + dy;
                    
                    if (nx >= 0 && nx < WIDTH && ny >= 0 && ny < HEIGHT) {
                        const nIdx = ny * WIDTH + nx;
                        if (grid[nIdx] === TREE) {
                            // Ignite neighbor
                            // "The next day all trees... will be burning"
                            // We mark for update. 
                            // Note: Avoid double-igniting in same tick is handled by checking grid state, 
                            // but multiple fires might target same tree. Using a map or just overwriting is fine.
                            changes.push({ index: nIdx, type: FIRE, timer: 3 });
                            
                            // It's a bit ambiguous if new fires start with full duration or if they burn immediately.
                            // "represented by a yellow pixel... disappear after 3 days" -> Timer = 3
                        }
                    }
                }
            }

            // Decay current fire
            const daysLeft = stateTimers[i] - 1;
            if (daysLeft <= 0) {
                changes.push({ index: i, type: EMPTY, timer: 0 });
            } else {
                // Update timer only (hack: we can modify stateTimers directly or push update)
                // Since stateTimers is parallel, we can just decrement. 
                // BUT, to be safe with the "next state" logic, let's push the update.
                changes.push({ index: i, type: FIRE, timer: daysLeft });
            }
        }
    }

    // Apply changes
    // Process "Fire" changes first? No, simple overwrite is fine.
    // However, we need to track stats for newly burnt trees.
    // A tree becomes fire in this step.
    changes.forEach(change => {
        // If transitioning from TREE to FIRE, increment burnt stat
        if (grid[change.index] === TREE && change.type === FIRE) {
            stats.burnt++;
        }
        
        grid[change.index] = change.type;
        stateTimers[change.index] = change.timer;
    });

    updateStats();
}

function spawnTree() {
    // Attempt to spawn a tree at random location
    // Try X times to find empty spot to avoid infinite loop on full grid
    for(let attempt=0; attempt<10; attempt++) {
        const idx = Math.floor(Math.random() * TOTAL_PIXELS);
        if (grid[idx] === EMPTY) {
            grid[idx] = TREE;
            stats.spawned++;
            break;
        }
    }
}

function spawnLightning(forceIndex = -1) {
    let idx = forceIndex;
    if (idx === -1) {
        idx = Math.floor(Math.random() * TOTAL_PIXELS);
    }
    
    stats.lightnings++;
    
    const currentType = grid[idx];
    
    // Visual: Always show white pixel for 1 day
    // Logic: If tree, it burns.
    
    if (currentType === TREE) {
        // "if there was a tree the tree is eliminated, and there is a fire for 1 day"
        // Prompt creates a slight conflict: "Lightning (white) will disappear after 1 day... fire pixels (yellow) disappear after 3 days"
        // Interpretation: 
        // Day 0: Lightning (White). Internally marked as "IGNITED"? 
        // Or immediately Fire?
        // Let's allow the Lightning pixel to override visual for Day 0.
        // And ensure it turns to Fire on Day 1.
        
        // Strategy: Set to LIGHTNING type.
        // But we need to know it SHOULD become fire.
        // Let's use a special flag or just handle it:
        // Actually, easiest way: 
        // Set to LIGHTNING. Next day, LIGHTNING decays. 
        // Wait, if it was a tree, we need fire next.
        
        // Let's cheat slightly for visual clarity:
        // If hit tree -> State = FIRE, but we render it WHITE for this frame? 
        // Or State = LIGHTNING, and we store "nextState = FIRE".
        // Let's use the timer for this.
        // If State = LIGHTNING and Timer = 10 (arbitrary code) -> Next is Fire?
        
        // Let's stick to prompt literal: "symbolized by a white pixel... for 1 simulated day"
        // "if there was a tree... there is a fire for 1 day" (Wait, 1 day or 3 days? Later it says "fire pixels (yellow) will disappear after 3 days")
        // Let's assume: Hit Tree -> Becomes Fire (starts with full life), but rendered White for first day.
        
        grid[idx] = FIRE; 
        stateTimers[idx] = 3; // Standard fire duration
        
        // We need a way to render it white TODAY.
        // We can check if it was just added? 
        // Simpler: Just spawn a visual particle? 
        // Or: Set grid[idx] = LIGHTNING. We need to remember to turn it to FIRE next tick.
        // Let's assume standard lightning on empty ground just fades.
        
        // Revised Strategy:
        // Hit Tree: Grid = LIGHTNING. stateTimers = 1. Special flag/map to convert to FIRE next day.
        // But Grid only stores one type.
        
        // Let's immediately transition to FIRE state logic, but overwrite grid with LIGHTNING for 1 tick.
        // We can't easily store "underlying" state in Uint8.
        
        // Simple Fix:
        // If hit Tree: 
        //   Stats.burnt++
        //   Grid[idx] = LIGHTNING
        //   We rely on a separate list of "Pending Fires" or encoded in stateTimers.
        //   Let's use stateTimers: If > 100, it means "Turn to Fire".
        
        grid[idx] = LIGHTNING;
        stateTimers[idx] = 100; // Magic number: will turn to fire next tick
        stats.burnt++;
    } else if (currentType !== FIRE && currentType !== LIGHTNING) {
        // Hit empty ground
        grid[idx] = LIGHTNING;
        stateTimers[idx] = 0; // Just visual, disappears next tick
    }
}

// Override simulateDay part for Lightning transition
// We need to catch that "Magic Number" in the simulation loop.
// Let's patch the `changes` logic in `simulateDay`:

/* 
   Inside simulateDay loop:
   if (type === LIGHTNING) {
       if (stateTimers[i] === 100) {
           // Was a tree hit. Become Fire.
           changes.push({ index: i, type: FIRE, timer: 3 });
       } else {
           // Just empty lightning
           changes.push({ index: i, type: EMPTY, timer: 0 });
       }
   }
*/

// --- Redefining simulateDay to include the logic fix ---
// (I will output the clean version below in the block)

// --- Rendering ---
function render() {
    // Create ImageData for speed
    const imgData = ctx.createImageData(WIDTH, HEIGHT);
    const data = imgData.data;

    // Get Colors
    const cTree = hexToRgb(els.params.colorTree.value);
    const cFire = hexToRgb(els.params.colorFire.value);
    const cLightning = hexToRgb(els.params.colorLightning.value);

    for (let i = 0; i < TOTAL_PIXELS; i++) {
        const type = grid[i];
        const offset = i * 4;
        
        if (type === EMPTY) {
            // Black transparent (or just black alpha 255)
            data[offset] = 0;
            data[offset+1] = 0;
            data[offset+2] = 0;
            data[offset+3] = 255;
        } else if (type === TREE) {
            data[offset] = cTree.r;
            data[offset+1] = cTree.g;
            data[offset+2] = cTree.b;
            data[offset+3] = 255;
        } else if (type === FIRE) {
            data[offset] = cFire.r;
            data[offset+1] = cFire.g;
            data[offset+2] = cFire.b;
            data[offset+3] = 255;
        } else if (type === LIGHTNING) {
            data[offset] = cLightning.r;
            data[offset+1] = cLightning.g;
            data[offset+2] = cLightning.b;
            data[offset+3] = 255;
        }
    }
    
    ctx.putImageData(imgData, 0, 0);
}

function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
}

function updateUI() {
    els.date.textContent = currentDate.toLocaleDateString();
}

function updateStats() {
    els.stats.lightnings.textContent = stats.lightnings;
    els.stats.spawned.textContent = stats.spawned;
    els.stats.burnt.textContent = stats.burnt;
}

// --- Event Listeners ---
els.btnPlay.addEventListener('click', () => {
    if (!isRunning) {
        isRunning = true;
        lastFrameTime = 0; // Reset delta tracking
    }
});

els.btnPause.addEventListener('click', () => isRunning = false);

els.btnReset.addEventListener('click', () => {
    isRunning = false;
    init();
});

// Manual Lightning
canvas.addEventListener('mousedown', (e) => {
    // Get coordinates
    const rect = canvas.getBoundingClientRect();
    
    // Scale click to canvas resolution
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const x = Math.floor((e.clientX - rect.left) * scaleX);
    const y = Math.floor((e.clientY - rect.top) * scaleY);

    if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) {
        const idx = y * WIDTH + x;
        spawnLightning(idx);
        render(); // Immediate feedback
    }
});

// Start loop
requestAnimationFrame(loop);

// Initial call
init();

// --- Overwriting simulateDay with correct logic mentioned above ---
simulateDay = function() {
    currentDate.setDate(currentDate.getDate() + 1);
    updateUI();

    // Spawning
    const treesPerMonth = parseInt(els.params.treesRate.value) || 0;
    let treesToSpawn = treesPerMonth / 30;
    let count = Math.floor(treesToSpawn) + (Math.random() < (treesToSpawn % 1) ? 1 : 0);
    for (let i = 0; i < count; i++) spawnTree();

    const lightningsPerMonth = parseInt(els.params.lightningRate.value) || 0;
    const lightningChance = lightningsPerMonth / 30;
    let lCount = Math.floor(lightningChance) + (Math.random() < (lightningChance % 1) ? 1 : 0);
    for (let i = 0; i < lCount; i++) spawnLightning();

    const changes = [];

    for (let i = 0; i < TOTAL_PIXELS; i++) {
        const type = grid[i];
        
        if (type === LIGHTNING) {
            // Check magic number for "Hit Tree"
            if (stateTimers[i] === 100) {
                changes.push({ index: i, type: FIRE, timer: 3 });
            } else {
                changes.push({ index: i, type: EMPTY, timer: 0 });
            }
        }
        else if (type === FIRE) {
            // Spread
            const x = i % WIDTH;
            const y = Math.floor(i / WIDTH);
            
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx >= 0 && nx < WIDTH && ny >= 0 && ny < HEIGHT) {
                        const nIdx = ny * WIDTH + nx;
                        // Important: Check current grid, not changes
                        // If it's a tree, it catches fire
                        if (grid[nIdx] === TREE) {
                            // Mark for update
                            // Check if we already scheduled a change for this? 
                            // Since we iterate sequentially, later updates overwrite.
                            // But we need to avoid processing a NEW fire in this same loop as an OLD fire.
                            // Reading from 'grid' ensures we only react to fires that existed at start of tick.
                            // Writing to 'changes' ensures we don't read new fires yet.
                            
                            // Prevent duplicate entries in changes? 
                            // Array push is fast, we can handle duplicates or just let last write win during apply.
                            changes.push({ index: nIdx, type: FIRE, timer: 3 });
                        }
                    }
                }
            }

            // Decay
            const daysLeft = stateTimers[i] - 1;
            if (daysLeft <= 0) {
                changes.push({ index: i, type: EMPTY, timer: 0 });
            } else {
                changes.push({ index: i, type: FIRE, timer: daysLeft });
            }
        }
    }

    // Apply Changes
    changes.forEach(change => {
        // Stats for transition TREE -> FIRE
        // We need to be careful not to double count if multiple neighbors ignited it.
        // Check if it's currently a tree and we haven't already processed it?
        // Actually, 'grid' hasn't changed yet. So:
        if (grid[change.index] === TREE && change.type === FIRE) {
            // Only count if it wasn't already marked as FIRE in this batch?
            // Since we might push multiple FIRE events for same pixel.
            // We can just count it when we modify grid.
            // But we need to know if we ALREADY modified it this frame.
            // This is getting complex for a simple loop.
            // Simplification: We accept potential minor stat race or use a `Set` for unique indices.
        }
        
        // Let's use the grid state check right before assignment
        if (change.type === FIRE && grid[change.index] === TREE) {
            stats.burnt++;
            grid[change.index] = FIRE; // Update immediately so next change for same index sees it's not TREE anymore
            stateTimers[change.index] = change.timer;
        } else {
            grid[change.index] = change.type;
            stateTimers[change.index] = change.timer;
        }
    });
    
    updateStats();
};