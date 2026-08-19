
const DESKTOP_CAMERA_ORBIT = '0deg 75deg 70%';
const MOBILE_CAMERA_ORBIT = '0deg 75deg 120%'; // zoomed out further so the car isn't edge-to-edge on narrow screens
const MOBILE_QUERY = window.matchMedia('(max-width: 767px)');

// Single source of truth for the part callouts: each entry renders as a
// hotspot (leader line + dot + label) anchored at its 3D position, and
// clicking it opens its parts list below the model.
const HOTSPOTS = [
  {
    id: 'frontBumper',
    label: 'Front Bumper',
    position: '0 0.38 2.44',
    normal: '0 0 1',
    parts: [
      'Front Bumper Cover',
      'Upper Grille',
      'Lower Grille',
      'Fog Light Bezels',
      'License Plate Bracket',
      'Bumper Reinforcement Bar',
      'Impact Absorber Foam',
      'Bumper Retaining Clips',
    ],
  },
  {
    id: 'rearBumper',
    label: 'Rear Bumper',
    position: '0 0.38 -2.43',
    normal: '0 0 -1',
    parts: [
      'Rear Bumper Cover',
      'Rear Reflectors',
      'Exhaust Finisher Trim',
      'Bumper Reinforcement Bar',
      'Rear Bumper Brackets',
      'Parking Sensor Housings',
    ],
  },
  {
    id: 'hood',
    label: 'Hood',
    position: '0 0.85 1.7',
    normal: '0 0.6 0.8',
    parts: [
      'Hood Panel',
      'Hood Insulator Pad',
      'Hood Hinges (L/R)',
      'Hood Latch Assembly',
      'Hood Support Strut',
      'Hood Bumpers/Stoppers',
    ],
  },
  {
    id: 'trunk',
    label: 'Trunk',
    position: '0 1.0 -2.1',
    normal: '0 0.6 -0.8',
    parts: [
      'Trunk Lid',
      'Trunk Weatherstrip Seal',
      'Trunk Torsion Bars',
      'Trunk Latch Assembly',
      'License Plate Light',
      'Trunk Liner/Trim Panel',
    ],
  },
];

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const viewer = document.querySelector('#carViewer');
const partsPanel = document.querySelector('#partsPanel');

// ---------------------------------------------------------------------------
// Responsive camera framing
// ---------------------------------------------------------------------------
// The desktop radius fills a wide frame; on a narrow phone viewport the same
// radius leaves the car almost edge-to-edge, so zoom out further below the
// tablet breakpoint. matchMedia reacts to resizes and orientation changes
// without polling.

function applyResponsiveFraming() {
  viewer.cameraOrbit = MOBILE_QUERY.matches ? MOBILE_CAMERA_ORBIT : DESKTOP_CAMERA_ORBIT;
}

applyResponsiveFraming();
MOBILE_QUERY.addEventListener('change', applyResponsiveFraming);

// ---------------------------------------------------------------------------
// Part callout hotspots
// ---------------------------------------------------------------------------

function createHotspotElement({ id, label, position, normal }) {
  const button = document.createElement('button');
  button.className = 'Hotspot';
  button.slot = `hotspot-${id}`;
  button.dataset.panel = id;
  button.dataset.position = position;
  button.dataset.normal = normal;
  button.innerHTML = `
    <span class="HotspotDot"></span>
    <span class="HotspotLine"></span>
    <span class="HotspotLabel">${label}</span>
  `;
  return button;
}

const hotspotsById = new Map(HOTSPOTS.map((hotspot) => [hotspot.id, hotspot]));
for (const hotspot of HOTSPOTS) {
  viewer.append(createHotspotElement(hotspot));
}

function renderPartsList({ label, parts }) {
  const items = parts.map((part) => `<li>${part}</li>`).join('');
  partsPanel.innerHTML = `<h3>${label} — Related Parts</h3><ul>${items}</ul>`;
  partsPanel.classList.add('open');
}

let activeHotspotId = null;

// One delegated listener for every hotspot instead of one per button.
viewer.addEventListener('click', (event) => {
  const button = event.target.closest('.Hotspot');
  if (!button) return;

  const { panel: id } = button.dataset;

  if (activeHotspotId === id) {
    // clicking the active hotspot again closes the list
    activeHotspotId = null;
    button.classList.remove('active');
    partsPanel.classList.remove('open');
    return;
  }

  viewer.querySelectorAll('.Hotspot.active').forEach((el) => el.classList.remove('active'));
  button.classList.add('active');
  activeHotspotId = id;
  renderPartsList(hotspotsById.get(id));
});

// Selecting a part in the list just highlights it -- no deeper 3D linkage
// yet, but it gives clear feedback that the row was clicked.
partsPanel.addEventListener('click', (event) => {
  const item = event.target.closest('li');
  if (!item) return;

  const alreadySelected = item.classList.contains('selected');
  partsPanel.querySelectorAll('li.selected').forEach((li) => li.classList.remove('selected'));
  if (!alreadySelected) item.classList.add('selected');
});

// Leader lines are authored pointing right by default, which only reads
// correctly while the anchor sits on the left half of the viewer. As the
// camera orbits, re-check each hotspot's projected screen position and flip
// the ones that have crossed to the right half so every line still points
// outward from the car instead of back across it.
function updateHotspotDirections() {
  const viewerRect = viewer.getBoundingClientRect();
  const centerX = viewerRect.left + viewerRect.width / 2;

  viewer.querySelectorAll('.Hotspot').forEach((button) => {
    const anchorX = button.getBoundingClientRect().left;
    button.classList.toggle('flip', anchorX > centerX);
  });
}

// camera-change can fire many times per drag gesture; coalesce to at most
// one recalculation per rendered frame.
let hotspotUpdateScheduled = false;
function scheduleHotspotUpdate() {
  if (hotspotUpdateScheduled) return;
  hotspotUpdateScheduled = true;
  requestAnimationFrame(() => {
    hotspotUpdateScheduled = false;
    updateHotspotDirections();
  });
}

viewer.addEventListener('camera-change', scheduleHotspotUpdate);

// ---------------------------------------------------------------------------
// Predetermined View Angles, Buttons & Gesture Controls
// ---------------------------------------------------------------------------

const PRESET_ANGLES = [
  '0deg 80deg',   // Front View
  '90deg 80deg',  // Right Side View
  '180deg 80deg', // Rear View
  '270deg 80deg'  // Left Side View
];

let currentViewIndex = 0;
let pointerStartX = 0;
let pointerStartY = 0;
let isTrackingSwipe = false;

const SWIPE_MIN_DISTANCE = 40; 

const prevBtn = document.querySelector('#prevViewBtn');
const nextBtn = document.querySelector('#nextViewBtn');

// Single source of truth to switch camera view
function applyViewIndex(targetIndex) {
  // Wrap index around boundaries (-1 goes to end, last+1 goes to 0)
  currentViewIndex = (targetIndex + PRESET_ANGLES.length) % PRESET_ANGLES.length;
  
  const radius = MOBILE_QUERY.matches ? '120%' : '70%';
  viewer.cameraOrbit = `${PRESET_ANGLES[currentViewIndex]} ${radius}`;
}

// Button Click Event Listeners
prevBtn.addEventListener('click', () => applyViewIndex(currentViewIndex - 1));
nextBtn.addEventListener('click', () => applyViewIndex(currentViewIndex + 1));

// Gesture Event Tracking
viewer.addEventListener('pointerdown', (event) => {
  isTrackingSwipe = true;
  pointerStartX = event.clientX;
  pointerStartY = event.clientY;
});

function processSwipeEnd(event) {
  if (!isTrackingSwipe) return;
  isTrackingSwipe = false;

  const pointerEndX = event.clientX;
  const pointerEndY = event.clientY;

  const deltaX = pointerEndX - pointerStartX;
  const deltaY = pointerEndY - pointerStartY;

  if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > SWIPE_MIN_DISTANCE) {
    if (deltaX < 0) {
      applyViewIndex(currentViewIndex + 1); // Swipe Left -> Next
    } else {
      applyViewIndex(currentViewIndex - 1); // Swipe Right -> Prev
    }
  }
}

window.addEventListener('pointerup', processSwipeEnd);
window.addEventListener('pointercancel', processSwipeEnd);

// ---------------------------------------------------------------------------
// Model lifecycle
// ---------------------------------------------------------------------------

viewer.addEventListener('load', updateHotspotDirections);

viewer.addEventListener('error', (event) => {
  console.error('model-viewer failed to load the model:', event.detail);
});
