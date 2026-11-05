/* Your own companion: a .glb model drawn with three.js in place of Cy's renders.
   Cy's brain keeps running (mood, speech bubble, activities, singing, attention): this module
   only reads Buddy.state every frame and moves the model to match. Animation clips are picked
   by name when the model has them (idle, wave, dance, sit, sleep, walk…); without clips the
   model turns toward what Cy looks at, breathes, hops and bobs to the music. */
const stage = document.getElementById('modelStage');
const mascot = document.getElementById('mascot');
let run = null; // the live model, or null

const CLIPS = {
  idle: /idle|breath|stand|rest/i, wave: /wave|hello|greet|hi\b/i, dance: /dance|sing|music|groove|jump/i,
  sit: /sit/i, sleep: /sleep|lie|lay|nap/i, cheer: /cheer|celebrat|victory|happy|yes/i, walk: /walk|run|move/i
};

async function start(c) {
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const canvas = document.createElement('canvas');
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power', preserveDrawingBuffer: true }); }
  catch (e) { throw new Error('This computer cannot draw 3D here (no WebGL).'); }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9c7ae, 2.1));
  const key = new THREE.DirectionalLight(0xfff0dc, 2.6); key.position.set(2, 4, 3); scene.add(key);
  const rim = new THREE.DirectionalLight(0xffd59a, 1.4); rim.position.set(-3, 2, -2); scene.add(rim);
  const camera = new THREE.PerspectiveCamera(30, 448 / 516, 0.01, 100);
  camera.position.set(0, 0.56, 3.2); camera.lookAt(0, 0.5, 0);

  const bytes = await window.cy.companionData(c.file);
  if (!bytes) throw new Error('The model file is missing. Pick it again in Settings.');
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new GLTFLoader().parseAsync(buf, '');
  const root = gltf.scene;
  // Feet on the floor, about one unit tall, centred.
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  root.position.set(-center.x, -box.min.y, -center.z);
  const pivot = new THREE.Group(), turn = new THREE.Group();
  turn.add(root); pivot.add(turn);
  pivot.scale.setScalar(1 / Math.max(size.y, size.x * 0.8, 1e-6));
  turn.rotation.y = ((c.turn || 0) * Math.PI) / 180;
  scene.add(pivot);

  const mixer = new THREE.AnimationMixer(root);
  const actions = {};
  for (const [k, re] of Object.entries(CLIPS)) {
    const clip = gltf.animations.find((a) => re.test(a.name));
    if (clip) actions[k] = mixer.clipAction(clip);
  }
  if (!actions.idle && gltf.animations.length === 1) actions.idle = mixer.clipAction(gltf.animations[0]);
  let playing = null;
  function play(name) {
    const a = actions[name] || actions.idle;
    if (!a || a === playing) return;
    a.reset().fadeIn(0.35).play();
    if (playing) playing.fadeOut(0.35);
    playing = a;
  }
  play('idle');

  stage.appendChild(canvas);
  mascot.classList.add('custom');
  window.Buddy.setHeadless(true);

  const clock = new THREE.Clock();
  let raf = null, last = 0, yaw = 0, pitch = 0, alive = true, spin = 0;
  function size2() {
    const r = stage.getBoundingClientRect(), dpr = Math.min(1.5, window.devicePixelRatio || 1);
    if (r.width && (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr))) {
      renderer.setPixelRatio(dpr); renderer.setSize(r.width, r.height, false);
      camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
    }
  }
  function frame(t) {
    raf = null;
    if (!alive) return;
    if (!document.body.classList.contains('paused') && t - last > 30) {
      const dt = Math.min(0.1, clock.getDelta());
      last = t;
      size2();
      const st = window.Buddy.state;
      // Head angles from Cy's attention model, smoothed a little more for a whole body.
      yaw += (((st.yaw || 0) * 1.3 * Math.PI) / 180 - yaw) * Math.min(1, dt * 6);
      pitch += (((st.pitch || 0) * 0.6 * Math.PI) / 180 - pitch) * Math.min(1, dt * 6);
      spin = st.activity === 'turnAround' ? spin + dt * Math.PI * 0.8 : spin * Math.max(0, 1 - dt * 4);
      pivot.rotation.set(pitch, yaw + spin, 0);
      const s = clock.elapsedTime;
      const want = st.singing ? 'dance' : st.asleep ? 'sleep' : st.sitting ? 'sit' : st.activity === 'wave' ? 'wave'
        : st.activity === 'dance' ? 'dance' : st.emote === 'love' ? 'cheer' : 'idle';
      play(want);
      // No clip for it: a bob to the music, a slow breath otherwise.
      const bob = (want === 'dance' && !actions.dance) ? Math.abs(Math.sin(s * 7)) * 0.05 : !playing ? Math.sin(s * 1.7) * 0.008 : 0;
      pivot.position.y = bob;
      mixer.update(dt);
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  return {
    stop() {
      alive = false; if (raf) cancelAnimationFrame(raf);
      mixer.stopAllAction(); renderer.dispose(); canvas.remove();
      mascot.classList.remove('custom'); window.Buddy.setHeadless(false);
    },
    clips: gltf.animations.map((a) => a.name), mapped: Object.keys(actions)
  };
}

async function apply(c) {
  if (run) { run.stop(); run = null; }
  window.__model = null;
  if (!c || c.type !== 'model' || !c.file) return null;
  try {
    run = await start(c);
    window.__model = { file: c.file, clips: run.clips, mapped: run.mapped };
    return window.__model;
  } catch (e) {
    console.warn('companion', e);
    window.Buddy.say(`I couldn't load your model: ${e.message} Back to me for now.`, 8000);
    window.__model = { error: e.message };
    return window.__model;
  }
}

window.Companion = { apply };
if (window.__companion) apply(window.__companion);
