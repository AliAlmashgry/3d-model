const viewer = document.querySelector('#carViewer');
      const viewLabel = document.querySelector('#viewLabel');

      const views = [
        { name: "Front View", orbit: "0deg 75deg 105%" },
        { name: "Right Side View", orbit: "90deg 75deg 105%" },
        { name: "Back View", orbit: "180deg 75deg 105%" },
        { name: "Left Side View", orbit: "-90deg 75deg 105%" },
        { name: "Top Down View", orbit: "0deg 10deg 105%" }
      ];

      let currentIndex = 0;

      function applyView(index) {
        currentIndex = index;
        const view = views[currentIndex];

        viewer.cameraOrbit = view.orbit;
        viewLabel.textContent = `Current View: ${view.name}`;
      }

      // Prev & Next Controls
      document.querySelector('#nextBtn').addEventListener('click', () => {
        const nextIndex = (currentIndex + 1) % views.length;
        applyView(nextIndex);
      });

      document.querySelector('#prevBtn').addEventListener('click', () => {
        const prevIndex = (currentIndex - 1 + views.length) % views.length;
        applyView(prevIndex);
      });

      // Direct View Buttons
      document.querySelector('#frontBtn').addEventListener('click', () => applyView(0));
      document.querySelector('#sideBtn').addEventListener('click', () => applyView(1));
      document.querySelector('#topBtn').addEventListener('click', () => applyView(4));

      function playAnim(animName) {
        // Set the active animation track
        viewer.animationName = animName;

        // Play the animation once and keep it in the open position
        viewer.play({ repetitions: 1, clampWhenFinished: true });
      }

      // --- Clay View (recolor materials at runtime, no Blender needed) ---
      const clayBtn = document.querySelector('#clayBtn');
      const CLAY_COLOR = [0.62, 0.62, 0.62, 1]; // neutral matte grey

      let clayMode = false;
      let originalMaterialProps = [];

      // Capture each material's real color/finish once the model has finished loading,
      // so we can restore it exactly when the user switches back.
      viewer.addEventListener('load', () => {
        // Brighten the ground/pedestal plane so its sloped faces don't shade grey
        // under studio lighting — makes it blend with the white page background.
        const groundMaterial = viewer.model.materials.find((m) => m.name === 'Material.003')
          || viewer.model.materials[0];
        if (groundMaterial) {
          groundMaterial.setEmissiveFactor([0.85, 0.85, 0.85]);
        }

        originalMaterialProps = viewer.model.materials.map((mat) => ({
          baseColorFactor: [...mat.pbrMetallicRoughness.baseColorFactor],
          metallicFactor: mat.pbrMetallicRoughness.metallicFactor,
          roughnessFactor: mat.pbrMetallicRoughness.roughnessFactor
        }));
        clayBtn.disabled = false;
        clayBtn.textContent = 'Clay View';
      });

      viewer.addEventListener('error', (event) => {
        console.error('model-viewer failed to load the model:', event.detail);
        clayBtn.textContent = 'Model failed to load';
      });

      function toggleClayMode() {
        if (originalMaterialProps.length === 0) return;

        clayMode = !clayMode;

        viewer.model.materials.forEach((mat, i) => {
          if (clayMode) {
            mat.pbrMetallicRoughness.setBaseColorFactor(CLAY_COLOR);
            mat.pbrMetallicRoughness.setMetallicFactor(0);
            mat.pbrMetallicRoughness.setRoughnessFactor(0.9);
          } else {
            const original = originalMaterialProps[i];
            mat.pbrMetallicRoughness.setBaseColorFactor(original.baseColorFactor);
            mat.pbrMetallicRoughness.setMetallicFactor(original.metallicFactor);
            mat.pbrMetallicRoughness.setRoughnessFactor(original.roughnessFactor);
          }
        });

        clayBtn.textContent = clayMode ? 'Original Colors' : 'Clay View';
      }