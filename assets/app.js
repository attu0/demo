// ==================== STATE ====================
    let isSimMode = false;
    let isConnected = false;
    const socket = io();

    // Rover & GPS state
    let roverState = {
      dir: 'STOP',
      vx: 0,
      vy: 0,
      treadOffset: 0,
      rpmL: 0,
      rpmR: 0,
      heading: 0,
      lat: 17.05420,
      lon: 74.26380
    };

    // 3-DOF Arm state
    let armCur = { base: 90, shoulder: 115, elbow: 75 };
    let armTgt = { base: 90, shoulder: 115, elbow: 75 };
    let isAutoSpraying = false;
    let sprayParticles = [];

    // Leaf CNN state
    let currentLeafSample = 'early_blight';
    let uploadedLeafImg = null;
    let scanLaserY = -1;
    let detectedBBox = null;
    let cpuLoad = 3;

    const LEAF_SAMPLES = {
      early_blight: {
        title: 'Early Blight',
        conf: 94.6,
        probs: { eb: 94.6, lb: 3.1, pm: 1.4, hl: 0.9 },
        sprayMs: 2600,
        bbox: { x: 135, y: 42, w: 145, h: 82, color: '#EF4444' },
        lesions: [{x: 185, y: 75, r: 16, c: '#5C3A21'}, {x: 230, y: 92, r: 13, c: '#4A2C18'}, {x: 165, y: 98, r: 10, c: '#6E472B'}]
      },
      powdery_mildew: {
        title: 'Powdery Mildew',
        conf: 91.8,
        probs: { eb: 4.2, lb: 2.5, pm: 91.8, hl: 1.5 },
        sprayMs: 2200,
        bbox: { x: 140, y: 38, w: 150, h: 86, color: '#F59E0B' },
        lesions: [{x: 190, y: 68, r: 18, c: '#CBD5E1'}, {x: 235, y: 88, r: 15, c: '#E2E8F0'}, {x: 165, y: 95, r: 12, c: '#94A3B8'}]
      },
      healthy: {
        title: 'Healthy',
        conf: 98.4,
        probs: { eb: 0.6, lb: 0.4, pm: 0.6, hl: 98.4 },
        sprayMs: 0,
        bbox: { x: 115, y: 28, w: 190, h: 105, color: '#10B981' },
        lesions: []
      }
    };

    // ==================== HELPERS ====================
    function logSerial(msg) {
      document.getElementById('serialLogTxt').textContent = msg;
    }

    let toastTimer = null;
    function requireActiveHardware() {
      if (isConnected || isSimMode) return true;
      const t = document.getElementById('toastAlert');
      t.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
      return false;
    }

    document.getElementById('toastCloseBtn').addEventListener('click', () => {
      document.getElementById('toastAlert').classList.remove('show');
      clearTimeout(toastTimer);
    });

    // Send one event to the board. `type` is the Socket.IO event name.
    function sendWS(payload, quiet = false) {
      const { type, ...data } = payload;
      if (isConnected) socket.emit(type, data);
      if (!quiet) logSerial(`TX -> UNO Q: ${type}`);
    }

    // ==================== SIM MODE & TOP-RIGHT THEME TOGGLE ====================
    const simToggle = document.getElementById('simToggle');
    const simLabel = document.getElementById('simLabel');

    simToggle.addEventListener('click', () => {
      isSimMode = !isSimMode;
      simToggle.classList.toggle('active', isSimMode);
      simLabel.textContent = isSimMode ? 'Sim Mode: ON' : 'Sim Mode: OFF';
      if (!isSimMode && !isConnected) {
        roverState.dir = 'STOP';
        roverState.vx = 0; roverState.vy = 0;
        roverState.rpmL = 0; roverState.rpmR = 0;
        isAutoSpraying = false;
        detectedBBox = null;
      }
      logSerial(isSimMode ? 'Sim Mode ON • 60FPS Visualizers Active' : 'Sim Mode OFF • Hardware Gating Active');
    });

    // Theme Switcher in Top-Right Header Corner
    const themeBtn = document.getElementById('themeBtn');
    const themeIcon = document.getElementById('themeIcon');
    const themeText = document.getElementById('themeText');

    themeBtn.addEventListener('click', () => {
      const html = document.documentElement;
      const nextTheme = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', nextTheme);
      if (nextTheme === 'light') {
        themeIcon.className = 'fa-solid fa-moon';
        themeText.textContent = 'Dark Mode';
      } else {
        themeIcon.className = 'fa-solid fa-sun';
        themeText.textContent = 'Light Mode';
      }
    });

    // ==================== CONTROL MODE TOGGLE (EITHER JOYSTICK OR BUTTONS) ====================
    document.querySelectorAll('.mode-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.mode-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;
        document.getElementById('paneJoystick').classList.toggle('active', mode === 'joystick');
        document.getElementById('paneButtons').classList.toggle('active', mode === 'buttons');
        if (isConnected || isSimMode) setRoverDrive('STOP');
      });
    });

    // ==================== SOCKET.IO CONNECTION ====================
    const linkPill = document.getElementById('linkPill');
    const linkTxt = document.getElementById('linkTxt');

    function setLink(up, text) {
      isConnected = up;
      linkPill.classList.toggle('up', up);
      linkTxt.textContent = text;
      document.getElementById('connectBtnTxt').textContent = up ? 'Reconnect' : 'Connect UNO Q';
    }

    socket.on('connect', () => { setLink(true, 'UNO Q linked'); logSerial('Connected to UNO Q'); });
    socket.on('disconnect', () => {
      setLink(false, 'Link lost');
      stopDriveLocal();
      logSerial('Link lost - rover stops after 0.5 s without commands');
    });
    socket.on('connect_error', () => setLink(false, 'Connecting…'));

    document.getElementById('connectBtn').addEventListener('click', () => {
      if (socket.connected) socket.disconnect();
      setTimeout(() => socket.connect(), 150);
    });

    socket.on('telemetry', t => {
      if (t.gps && t.gps.fix) { roverState.lat = +t.gps.lat; roverState.lon = +t.gps.lon; }
      if (t.heading != null) roverState.heading = +t.heading;
      updateGpsDisplay();
      if (t.cpu != null) document.getElementById('cpuTxt').textContent = `${Math.round(t.cpu)}%`;
      if (t.ram) document.getElementById('ramTxt').textContent = t.ram;
      if (!isSimMode && t.rpm) {
        roverState.rpmL = t.rpm[0]; roverState.rpmR = t.rpm[1];
        document.getElementById('rpmLeftTxt').textContent = `L: ${Math.round(t.rpm[0])} RPM`;
        document.getElementById('rpmRightTxt').textContent = `R: ${Math.round(t.rpm[1])} RPM`;
      }
    });
    socket.on('log', m => logSerial(m));
    socket.on('cnn_result', data => applyCNNResult(data));

    function updateGpsDisplay() {
      const latStr = roverState.lat.toFixed(4);
      const lonStr = roverState.lon.toFixed(4);
      document.getElementById('gpsCoordTxt').innerHTML = `LAT: ${latStr}° N &nbsp; LON: ${lonStr}° E`;
      document.getElementById('vpGpsChip').innerHTML = `<i class="fa-solid fa-satellite-dish" style="color:var(--arduino-teal-bright);"></i> ${latStr}°N, ${lonStr}°E`;
      document.getElementById('vpHdgChip').textContent = `HDG: ${Math.round(roverState.heading)}°`;
    }

    // ==================== PANEL 1: ROVER D-PAD & 360 JOYSTICK ====================
    // Board watchdog stops the rover if no "drive" arrives for 0.5 s,
    // so the current command is re-sent at 10 Hz while it is non-zero.
    let driveCmd = { linear: 0, angular: 0 };
    let driveTimer = null;

    function pushDrive() { if (isConnected) socket.emit('drive', driveCmd); }
    function setDriveCmd(linear, angular) {
      driveCmd = { linear, angular };
      pushDrive();
      const moving = linear !== 0 || angular !== 0;
      if (moving && !driveTimer) driveTimer = setInterval(pushDrive, 100);
      if (!moving && driveTimer) { clearInterval(driveTimer); driveTimer = null; }
    }
    function stopDriveLocal() {
      setDriveCmd(0, 0);
      roverState.dir = 'STOP'; roverState.vx = 0; roverState.vy = 0;
      roverState.rpmL = 0; roverState.rpmR = 0;
      document.getElementById('roverStateTxt').textContent = 'Standby';
      document.getElementById('rpmLeftTxt').textContent = 'L: 0 RPM';
      document.getElementById('rpmRightTxt').textContent = 'R: 0 RPM';
      document.getElementById('roverVecTxt').textContent = 'Idle';
    }

    function setRoverDrive(dir, vx = 0, vy = 0) {
      if (!requireActiveHardware()) return;
      roverState.dir = dir;
      roverState.vx = vx;
      roverState.vy = vy;

      // linear: +forward, angular: +left (matches main.py)
      let lin = 0, ang = 0;
      if (dir === 'FORWARD')       { roverState.rpmL = 120;  roverState.rpmR = 120;  roverState.vy = 1;  lin = 0.6; }
      else if (dir === 'BACKWARD') { roverState.rpmL = -120; roverState.rpmR = -120; roverState.vy = -1; lin = -0.6; }
      else if (dir === 'LEFT')     { roverState.rpmL = -95;  roverState.rpmR = 95;   roverState.vx = -1; ang = 0.6; }
      else if (dir === 'RIGHT')    { roverState.rpmL = 95;   roverState.rpmR = -95;  roverState.vx = 1;  ang = -0.6; }
      else if (dir === 'STOP')     { roverState.rpmL = 0; roverState.rpmR = 0; roverState.vx = 0; roverState.vy = 0; }

      document.getElementById('roverStateTxt').textContent = dir === 'STOP' ? 'Standby' : dir;
      document.getElementById('rpmLeftTxt').textContent = `L: ${Math.round(roverState.rpmL)} RPM`;
      document.getElementById('rpmRightTxt').textContent = `R: ${Math.round(roverState.rpmR)} RPM`;
      document.getElementById('roverVecTxt').textContent = dir === 'STOP' ? 'Idle' : `CMD: ${dir}`;
      setDriveCmd(lin, ang);
    }

    function emergencyStop() {
      stopDriveLocal();
      isAutoSpraying = false;
      if (isConnected) socket.emit('estop', {});
      logSerial('EMERGENCY STOP Triggered');
    }

    // D-pad (pointer events: mouse + touch)
    document.querySelectorAll('.dpad-btn').forEach(btn => {
      const dir = btn.dataset.dir;
      btn.addEventListener('pointerdown', (e) => {
        btn.setPointerCapture(e.pointerId);
        btn.classList.add('active');
        if (dir === 'STOP') emergencyStop(); else setRoverDrive(dir);
      });
      const up = () => {
        btn.classList.remove('active');
        if (dir !== 'STOP') setRoverDrive('STOP');
      };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
    });

    // Emergency Stop in bottom status bar (works even when offline)
    document.getElementById('emergencyStopBtn').addEventListener('click', emergencyStop);

    // Keyboard WASD / arrows, Space = stop
    const heldKeys = new Set();
    const KEYDIR = { w:'FORWARD', arrowup:'FORWARD', s:'BACKWARD', arrowdown:'BACKWARD',
                     a:'LEFT', arrowleft:'LEFT', d:'RIGHT', arrowright:'RIGHT' };
    window.addEventListener('keydown', (e) => {
      if (document.activeElement.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (k === ' ') { e.preventDefault(); emergencyStop(); return; }
      if (KEYDIR[k] && !e.repeat) { heldKeys.add(k); setRoverDrive(KEYDIR[k]); }
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (!KEYDIR[k]) return;
      heldKeys.delete(k);
      if (heldKeys.size) setRoverDrive(KEYDIR[[...heldKeys].pop()]);
      else setRoverDrive('STOP');
    });
    // Never keep driving if the tab loses focus
    window.addEventListener('blur', () => { heldKeys.clear(); if (driveTimer) emergencyStop(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && driveTimer) emergencyStop(); });

    // 360 Virtual Joystick
    const joyBase = document.getElementById('joyBase');
    const joyStick = document.getElementById('joyStick');
    let joyDragging = false;

    function handleJoyMove(clientX, clientY) {
      if (!joyDragging) return;
      if (!requireActiveHardware()) { joyDragging = false; return; }
      const rect = joyBase.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const maxR = 40;
      let dx = clientX - cx;
      let dy = clientY - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > maxR) {
        dx = (dx / dist) * maxR;
        dy = (dy / dist) * maxR;
      }
      joyStick.style.transform = `translate(${dx}px, ${dy}px)`;

      const nx = +(dx / maxR).toFixed(2);
      const ny = +(-dy / maxR).toFixed(2);
      const deg = Math.round((Math.atan2(ny, nx) * 180) / Math.PI);

      document.getElementById('joyX').textContent = `X: ${nx.toFixed(2)}`;
      document.getElementById('joyY').textContent = `Y: ${ny.toFixed(2)}`;
      document.getElementById('joyDeg').textContent = `HDG: ${deg}°`;

      roverState.vx = nx;
      roverState.vy = ny;
      roverState.rpmL = Math.round((ny + nx * 0.7) * 130);
      roverState.rpmR = Math.round((ny - nx * 0.7) * 130);
      roverState.dir = Math.hypot(nx, ny) > 0.12 ? 'JOYSTICK' : 'STOP';

      document.getElementById('roverStateTxt').textContent = roverState.dir === 'STOP' ? 'Standby' : 'Vector Drive';
      document.getElementById('rpmLeftTxt').textContent = `L: ${roverState.rpmL} RPM`;
      document.getElementById('rpmRightTxt').textContent = `R: ${roverState.rpmR} RPM`;
      document.getElementById('roverVecTxt').textContent = `JOY: ${nx},${ny}`;
      setDriveCmd(ny, -nx);   // linear = forward, angular = left
    }

    function resetJoystick() {
      if (!joyDragging) return;
      joyDragging = false;
      joyStick.style.transform = `translate(0px, 0px)`;
      document.getElementById('joyX').textContent = `X: 0.00`;
      document.getElementById('joyY').textContent = `Y: 0.00`;
      document.getElementById('joyDeg').textContent = `HDG: 0°`;
      if (isConnected || isSimMode) setRoverDrive('STOP');
    }

    joyBase.addEventListener('pointerdown', (e) => { joyDragging = true; joyBase.setPointerCapture(e.pointerId); handleJoyMove(e.clientX, e.clientY); });
    window.addEventListener('pointermove', (e) => handleJoyMove(e.clientX, e.clientY));
    window.addEventListener('pointerup', resetJoystick);
    window.addEventListener('pointercancel', resetJoystick);

    // ==================== PANEL 2: 3-DOF ARM CONTROLS ====================
    const sBase = document.getElementById('sliderBase');
    const sShoulder = document.getElementById('sliderShoulder');
    const sElbow = document.getElementById('sliderElbow');

    let armSendTimer = null;
    function sendArmThrottled() {
      if (armSendTimer) return;
      armSendTimer = setTimeout(() => {
        armSendTimer = null;
        sendWS({ type: 'arm', joints: [armTgt.base, armTgt.shoulder, armTgt.elbow] }, true);
      }, 50);
    }

    function updateArmTarget(base, shoulder, elbow, poseLabel = 'CUSTOM') {
      if (!requireActiveHardware()) {
        sBase.value = Math.round(armTgt.base);
        sShoulder.value = Math.round(armTgt.shoulder);
        sElbow.value = Math.round(armTgt.elbow);
        return;
      }
      armTgt = { base: +base, shoulder: +shoulder, elbow: +elbow };
      sBase.value = armTgt.base;
      sShoulder.value = armTgt.shoulder;
      sElbow.value = armTgt.elbow;
      document.getElementById('valBase').textContent = `${armTgt.base}°`;
      document.getElementById('valShoulder').textContent = `${armTgt.shoulder}°`;
      document.getElementById('valElbow').textContent = `${armTgt.elbow}°`;
      document.getElementById('armPoseChip').textContent = `POSE: ${poseLabel}`;
      document.getElementById('armPoseTxt').textContent = `Pose: ${poseLabel}`;
      document.getElementById('yawChip').textContent = `BASE YAW: ${armTgt.base}°`;
      sendArmThrottled();
    }

    [sBase, sShoulder, sElbow].forEach(el => {
      el.addEventListener('input', () => {
        document.querySelectorAll('.pose-row .btn-secondary').forEach(b => b.classList.remove('active'));
        updateArmTarget(sBase.value, sShoulder.value, sElbow.value, 'MANUAL');
      });
    });

    const POSES = {
      HOME:  { base: 90, shoulder: 115, elbow: 75 },
      SCAN:  { base: 90, shoulder: 85,  elbow: 110 },
      SPRAY: { base: 90, shoulder: 68,  elbow: 95 },
      STOW:  { base: 90, shoulder: 148, elbow: 35 }
    };

    document.querySelectorAll('.pose-row .btn-secondary').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.pose-row .btn-secondary').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const p = POSES[btn.dataset.pose];
        updateArmTarget(p.base, p.shoulder, p.elbow, btn.dataset.pose);
      });
    });

    // ==================== PANEL 3: LEAF CNN & AUTO-SPRINKLER ====================
    document.querySelectorAll('.cam-actions-left .btn-secondary').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.cam-actions-left .btn-secondary').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentLeafSample = btn.dataset.sample;
        uploadedLeafImg = null;
        detectedBBox = null;
      });
    });

    document.getElementById('leafUpload').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const img = new Image();
      img.onload = () => { uploadedLeafImg = img; detectedBBox = null; };
      img.src = URL.createObjectURL(file);
    });

    function setPipelineStep(stepNum) {
      [1,2,3,4].forEach(n => {
        document.getElementById(`step${n}`).classList.toggle('active', n <= stepNum);
      });
    }

    // Applies a CNN result (from the board, or from the local sim samples)
    function applyCNNResult(res) {
      // Accept board-style keys too
      if (res.sprayMs == null) res.sprayMs = res.spray_ms || 0;
      if (res.sample && LEAF_SAMPLES[res.sample]) currentLeafSample = res.sample;
      const known = LEAF_SAMPLES[currentLeafSample];
      if (!res.bbox) res.bbox = known.bbox;
      setPipelineStep(3);
      detectedBBox = res.bbox;
      scanLaserY = -1;
      cpuLoad = 6;
      if (!isConnected) document.getElementById('cpuTxt').textContent = `${cpuLoad}%`;

      document.getElementById('confPctTxt').textContent = `${Math.round(res.conf)}%`;
      const offset = 201 - (201 * res.conf) / 100;
      const arc = document.getElementById('confArc');
      arc.style.strokeDashoffset = offset;
      arc.style.stroke = res.sprayMs > 0 ? '#F59E0B' : '#10B981';

      document.getElementById('diseaseNameTxt').textContent = res.title.toUpperCase();
      document.getElementById('pctEB').textContent = `${res.probs.eb}%`;
      document.getElementById('barEB').style.width = `${res.probs.eb}%`;
      document.getElementById('pctLB').textContent = `${res.probs.lb}%`;
      document.getElementById('barLB').style.width = `${res.probs.lb}%`;
      document.getElementById('pctPM').textContent = `${res.probs.pm}%`;
      document.getElementById('barPM').style.width = `${res.probs.pm}%`;
      document.getElementById('pctHL').textContent = `${res.probs.hl}%`;
      document.getElementById('barHL').style.width = `${res.probs.hl}%`;

      setTimeout(() => {
        setPipelineStep(4);
        const banner = document.getElementById('nozzleBanner');
        const stateTxt = document.getElementById('nozzleStateTxt');
        const actionBar = document.getElementById('cnnActionTxt');

        if (res.sprayMs > 0) {
          updateArmTarget(90, 68, 95, 'AUTO-SPRAY');
          isAutoSpraying = true;
          banner.className = 'nozzle-auto-banner spraying';
          stateTxt.textContent = `AUTO-SPRAYING (${(res.sprayMs/1000).toFixed(1)}s)`;
          actionBar.textContent = `CNN Detected ${res.title} (${res.conf}%) -> Auto-Triggered Nozzle for ${res.sprayMs}ms.`;
          logSerial(`CNN -> MEGA: <SPRY:AUTO,${res.sprayMs}>`);

          setTimeout(() => {
            isAutoSpraying = false;
            banner.className = 'nozzle-auto-banner';
            stateTxt.textContent = 'CYCLE COMPLETE • STANDBY';
            cpuLoad = 3;
            if (!isConnected) document.getElementById('cpuTxt').textContent = `${cpuLoad}%`;
          }, res.sprayMs);
        } else {
          isAutoSpraying = false;
          banner.className = 'nozzle-auto-banner bypassed';
          stateTxt.textContent = 'BYPASSED • HEALTHY LEAF (0s)';
          actionBar.textContent = `CNN Verified Healthy Leaf (${res.conf}%) -> Sprinkler Automatically Bypassed.`;
          logSerial(`CNN -> MEGA: <SPRY:SKIP,0>`);
          cpuLoad = 3;
          if (!isConnected) document.getElementById('cpuTxt').textContent = `${cpuLoad}%`;
        }
      }, 350);
    }

    document.getElementById('scanLeafBtn').addEventListener('click', () => {
      if (!requireActiveHardware()) return;
      detectedBBox = null;
      scanLaserY = 0;
      cpuLoad = 38;
      if (!isConnected) document.getElementById('cpuTxt').textContent = `${cpuLoad}%`;
      setPipelineStep(1);
      updateArmTarget(90, 85, 110, 'SCANNING');

      setTimeout(() => setPipelineStep(2), 450);
      if (isConnected && !isSimMode) {
        // Real inference on the board. Send a frame if the user uploaded one.
        let image = null;
        if (uploadedLeafImg) {
          const c = document.createElement('canvas');
          c.width = 224; c.height = 224;
          try { c.getContext('2d').drawImage(uploadedLeafImg, 0, 0, 224, 224); image = c.toDataURL('image/jpeg', 0.8); } catch (e) {}
        }
        socket.emit('cnn_predict', { source: uploadedLeafImg ? 'upload' : 'arm_camera', sample: currentLeafSample, image });
      } else {
        setTimeout(() => applyCNNResult(LEAF_SAMPLES[currentLeafSample]), 1200);
      }
    });

    // ==================== THEME-AWARE 60FPS CANVAS RENDERERS ====================
    const roverCanvas = document.getElementById('roverCanvas');
    const rCtx = roverCanvas.getContext('2d');
    const armCanvas = document.getElementById('armCanvas');
    const aCtx = armCanvas.getContext('2d');
    const leafCanvas = document.getElementById('leafCanvas');
    const lCtx = leafCanvas.getContext('2d');

    function isLightMode() {
      return document.documentElement.getAttribute('data-theme') === 'light';
    }

    function drawRoverCanvas() {
      const W = roverCanvas.width, H = roverCanvas.height;
      rCtx.clearRect(0, 0, W, H);
      const light = isLightMode();

      // Crop row guide lines
      rCtx.strokeStyle = light ? 'rgba(5, 150, 105, 0.35)' : 'rgba(16, 185, 129, 0.22)';
      rCtx.lineWidth = 2;
      rCtx.setLineDash([8, 8]);
      rCtx.beginPath();
      rCtx.moveTo(95, 0); rCtx.lineTo(95, H);
      rCtx.moveTo(W - 95, 0); rCtx.lineTo(W - 95, H);
      rCtx.stroke();
      rCtx.setLineDash([]);

      // Update tread & live GPS coordinates when moving
      if ((isConnected || isSimMode) && (roverState.rpmL !== 0 || roverState.rpmR !== 0)) {
        const avgRpm = (roverState.rpmL + roverState.rpmR) / 2;
        roverState.treadOffset = (roverState.treadOffset + avgRpm * 0.015) % 14;
        roverState.heading = (roverState.heading + (roverState.rpmL - roverState.rpmR) * 0.01 + 360) % 360;
        const rad = (roverState.heading * Math.PI) / 180;
        roverState.lat += Math.cos(rad) * (avgRpm * 0.00000008);
        roverState.lon += Math.sin(rad) * (avgRpm * 0.00000008);
        updateGpsDisplay();
      }

      const cx = W / 2, cy = H / 2;
      rCtx.save();
      rCtx.translate(cx, cy);

      // Left & Right Rubber Tracks
      [-56, 38].forEach((tx, idx) => {
        rCtx.fillStyle = light ? '#334155' : '#1E293B';
        rCtx.strokeStyle = light ? '#0F172A' : '#475569';
        rCtx.lineWidth = 1.5;
        rCtx.beginPath();
        rCtx.roundRect(tx, -44, 18, 88, 5);
        rCtx.fill();
        rCtx.stroke();

        // Moving tread grooves
        rCtx.strokeStyle = '#00C2CB';
        rCtx.lineWidth = 2;
        const dirShift = idx === 0 ? roverState.rpmL : roverState.rpmR;
        const off = ((Date.now() * dirShift * 0.004) % 12 + 12) % 12;
        for (let y = -38 + off; y < 40; y += 12) {
          rCtx.beginPath();
          rCtx.moveTo(tx + 3, y);
          rCtx.lineTo(tx + 15, y);
          rCtx.stroke();
        }
      });

      // Main Rover Armored Chassis
      rCtx.fillStyle = '#0F172A';
      rCtx.strokeStyle = '#00979D';
      rCtx.lineWidth = 2;
      rCtx.beginPath();
      rCtx.roundRect(-38, -38, 76, 76, 8);
      rCtx.fill();
      rCtx.stroke();

      // Inner UNO Q Deck Accent
      rCtx.fillStyle = 'rgba(0, 151, 157, 0.25)';
      rCtx.fillRect(-26, -22, 52, 44);

      // Center Turntable Ring
      rCtx.strokeStyle = '#38BDF8';
      rCtx.lineWidth = 1.8;
      rCtx.beginPath();
      rCtx.arc(0, 0, 13, 0, Math.PI * 2);
      rCtx.stroke();

      // Front Sonar Cone when active
      if ((isConnected || isSimMode) && (Math.abs(roverState.rpmL) > 0 || Math.abs(roverState.rpmR) > 0)) {
        rCtx.strokeStyle = light ? '#0284C7' : 'rgba(56, 189, 248, 0.65)';
        for (let r = 12; r <= 30; r += 9) {
          rCtx.beginPath();
          rCtx.arc(0, -42, r, -Math.PI * 0.75, -Math.PI * 0.25);
          rCtx.stroke();
        }
      }

      rCtx.restore();
    }

    function drawArmCanvas() {
      const W = armCanvas.width, H = armCanvas.height;
      aCtx.clearRect(0, 0, W, H);
      const light = isLightMode();

      if (isConnected || isSimMode) {
        armCur.base += (armTgt.base - armCur.base) * 0.12;
        armCur.shoulder += (armTgt.shoulder - armCur.shoulder) * 0.12;
        armCur.elbow += (armTgt.elbow - armCur.elbow) * 0.12;
      }

      // Ground line
      aCtx.strokeStyle = light ? '#CBD5E1' : '#222D36';
      aCtx.lineWidth = 2;
      aCtx.beginPath();
      aCtx.moveTo(20, H - 16);
      aCtx.lineTo(W - 20, H - 16);
      aCtx.stroke();

      // Target Plant on Right Side
      const plantX = 335, plantY = H - 16;
      aCtx.strokeStyle = '#15803D';
      aCtx.lineWidth = 3;
      aCtx.beginPath();
      aCtx.moveTo(plantX, plantY);
      aCtx.lineTo(plantX, plantY - 90);
      aCtx.stroke();
      [{dx: -18, dy: -68, r: -0.35}, {dx: 16, dy: -52, r: 0.35}].forEach(lf => {
        aCtx.save();
        aCtx.translate(plantX + lf.dx, plantY + lf.dy);
        aCtx.rotate(lf.r);
        aCtx.fillStyle = isAutoSpraying ? '#10B981' : '#16A34A';
        aCtx.beginPath();
        aCtx.ellipse(0, 0, 16, 8, 0, 0, Math.PI * 2);
        aCtx.fill();
        aCtx.restore();
      });

      // Rover Deck Base at Bottom Center-Left
      const baseX = 155, baseY = H - 20;
      aCtx.fillStyle = light ? '#334155' : '#1E293B';
      aCtx.strokeStyle = '#00979D';
      aCtx.lineWidth = 2;
      aCtx.beginPath();
      aCtx.roundRect(baseX - 46, baseY, 92, 15, 4);
      aCtx.fill();
      aCtx.stroke();

      // Rotating Turntable Pedestal (DOF 1 Base Yaw)
      aCtx.fillStyle = '#00979D';
      aCtx.fillRect(baseX - 18, baseY - 10, 36, 10);

      // Calculate Link 1 (DOF 2 Shoulder Pitch)
      const L1 = 60, L2 = 54;
      const shRad = (-armCur.shoulder * Math.PI) / 180;
      const j1x = baseX + Math.cos(shRad) * L1;
      const j1y = (baseY - 10) + Math.sin(shRad) * L1;

      // Calculate Link 2 (DOF 3 Elbow Pitch)
      const elRad = shRad + ((90 - armCur.elbow) * Math.PI) / 180;
      const j2x = j1x + Math.cos(elRad) * L2;
      const j2y = j1y + Math.sin(elRad) * L2;

      // Draw Link 1 (Shoulder)
      aCtx.strokeStyle = '#00979D';
      aCtx.lineWidth = 9;
      aCtx.lineCap = 'round';
      aCtx.beginPath();
      aCtx.moveTo(baseX, baseY - 10);
      aCtx.lineTo(j1x, j1y);
      aCtx.stroke();

      // Draw Link 2 (Elbow)
      aCtx.strokeStyle = light ? '#0284C7' : '#38BDF8';
      aCtx.lineWidth = 7;
      aCtx.beginPath();
      aCtx.moveTo(j1x, j1y);
      aCtx.lineTo(j2x, j2y);
      aCtx.stroke();

      // Draw Servo Pivot Joints
      [[baseX, baseY - 10], [j1x, j1y]].forEach(([jx, jy]) => {
        aCtx.fillStyle = light ? '#FFFFFF' : '#0F172A';
        aCtx.strokeStyle = light ? '#0F172A' : '#F8FAFC';
        aCtx.lineWidth = 2;
        aCtx.beginPath();
        aCtx.arc(jx, jy, 6, 0, Math.PI * 2);
        aCtx.fill();
        aCtx.stroke();
      });

      // End-Effector: Vision Camera + Sprinkling Nozzle Head
      aCtx.save();
      aCtx.translate(j2x, j2y);
      aCtx.rotate(elRad);

      // Camera FOV Cone
      aCtx.fillStyle = light ? 'rgba(2, 132, 199, 0.18)' : 'rgba(56, 189, 248, 0.18)';
      aCtx.beginPath();
      aCtx.moveTo(12, -3);
      aCtx.lineTo(75, -24);
      aCtx.lineTo(75, 18);
      aCtx.closePath();
      aCtx.fill();

      // Camera & Nozzle Housing
      aCtx.fillStyle = '#0F172A';
      aCtx.strokeStyle = '#00C2CB';
      aCtx.lineWidth = 2;
      aCtx.beginPath();
      aCtx.roundRect(-6, -9, 22, 18, 4);
      aCtx.fill();
      aCtx.stroke();

      // Nozzle Tip (Amber)
      aCtx.fillStyle = '#F59E0B';
      aCtx.fillRect(16, 2, 6, 5);
      aCtx.restore();

      // Autonomous Spray Particles
      if (isAutoSpraying && (isConnected || isSimMode)) {
        for (let i = 0; i < 3; i++) {
          sprayParticles.push({
            x: j2x + Math.cos(elRad) * 20,
            y: j2y + Math.sin(elRad) * 20,
            vx: Math.cos(elRad + (Math.random() - 0.5) * 0.45) * (3.8 + Math.random() * 2),
            vy: Math.sin(elRad + (Math.random() - 0.5) * 0.45) * (3.8 + Math.random() * 2),
            alpha: 1
          });
        }
      }

      for (let i = sprayParticles.length - 1; i >= 0; i--) {
        const p = sprayParticles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.08;
        p.alpha -= 0.03;
        if (p.alpha <= 0) {
          sprayParticles.splice(i, 1);
          continue;
        }
        aCtx.fillStyle = `rgba(16, 185, 129, ${p.alpha})`;
        aCtx.beginPath();
        aCtx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
        aCtx.fill();
      }
    }

    function drawLeafCanvas() {
      const W = leafCanvas.width, H = leafCanvas.height;
      lCtx.clearRect(0, 0, W, H);

      if (uploadedLeafImg) {
        lCtx.drawImage(uploadedLeafImg, 0, 0, W, H);
      } else {
        const sample = LEAF_SAMPLES[currentLeafSample];
        lCtx.save();
        const grad = lCtx.createLinearGradient(110, 25, 310, 145);
        grad.addColorStop(0, '#16A34A');
        grad.addColorStop(0.6, '#15803D');
        grad.addColorStop(1, '#14532D');
        lCtx.fillStyle = grad;
        lCtx.strokeStyle = '#15803D';
        lCtx.lineWidth = 1.5;
        lCtx.beginPath();
        lCtx.moveTo(110, 88);
        lCtx.quadraticCurveTo(190, 14, 310, 84);
        lCtx.quadraticCurveTo(190, 154, 110, 88);
        lCtx.fill();
        lCtx.stroke();

        // Midrib & Veins
        lCtx.strokeStyle = 'rgba(187, 247, 208, 0.55)';
        lCtx.lineWidth = 2;
        lCtx.beginPath();
        lCtx.moveTo(95, 88);
        lCtx.lineTo(298, 85);
        lCtx.stroke();

        // Disease Lesions
        sample.lesions.forEach(ls => {
          lCtx.fillStyle = ls.c;
          lCtx.beginPath();
          lCtx.arc(ls.x, ls.y, ls.r, 0, Math.PI * 2);
          lCtx.fill();
          lCtx.strokeStyle = '#F59E0B';
          lCtx.lineWidth = 1.2;
          lCtx.stroke();
        });
        lCtx.restore();
      }

      // Laser Scan Line during CNN Inference
      if (scanLaserY >= 0) {
        scanLaserY = (scanLaserY + 3.4) % H;
        lCtx.strokeStyle = '#00C2CB';
        lCtx.lineWidth = 2.5;
        lCtx.beginPath();
        lCtx.moveTo(0, scanLaserY);
        lCtx.lineTo(W, scanLaserY);
        lCtx.stroke();
      }

      // Detected Bounding Box Overlay
      if (detectedBBox) {
        lCtx.strokeStyle = detectedBBox.color;
        lCtx.lineWidth = 2;
        lCtx.strokeRect(detectedBBox.x, detectedBBox.y, detectedBBox.w, detectedBBox.h);
        lCtx.fillStyle = detectedBBox.color;
        lCtx.fillRect(detectedBBox.x, detectedBBox.y - 16, 130, 16);
        lCtx.fillStyle = '#FFFFFF';
        lCtx.font = 'bold 10px IBM Plex Mono';
        lCtx.fillText(LEAF_SAMPLES[currentLeafSample].title.toUpperCase(), detectedBBox.x + 5, detectedBBox.y - 4);
      }
    }

    function animateLoop() {
      drawRoverCanvas();
      drawArmCanvas();
      drawLeafCanvas();
      requestAnimationFrame(animateLoop);
    }
    animateLoop();


// ==================== SYSTEM RESOURCES LOGGER ====================
(function () {
  const LIVE_MAX = 60;                 // 60 samples x 5 s = 5 min
  const modal = document.getElementById('resModal');
  const hint = document.getElementById('resHint');
  const liveDot = document.getElementById('resLiveDot');
  const charts = {
    cpu: { canvas: document.getElementById('resCpuCanvas'), no: document.getElementById('resCpuNo'),
           color: '#38BDF8', live: [], hist: { '1h': [], '1d': [] }, hover: -1, key: 'cpu' },
    mem: { canvas: document.getElementById('resMemCanvas'), no: document.getElementById('resMemNo'),
           color: '#10B981', live: [], hist: { '1h': [], '1d': [] }, hover: -1, key: 'mem' },
  };
  let tab = 'live', dotTimer = null;

  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function fmt(ts, mode) {
    const d = new Date(ts);
    if (mode === 'live') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (mode === '1h') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleTimeString([], { hour: '2-digit' });
  }
  const pts = c => tab === 'live' ? c.live : c.hist[tab];

  function draw(c) {
    const cv = c.canvas, data = pts(c);
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    c.no.style.display = data.length ? 'none' : 'flex';
    if (!data.length) return;

    const L = 32, R = 10, T = 8, B = 26, pw = W - L - R, ph = H - T - B;
    const muted = cssVar('--text-muted'), grid = cssVar('--border-subtle');
    g.font = '10px "IBM Plex Mono", monospace';
    g.textBaseline = 'middle'; g.textAlign = 'right';
    for (let v = 0; v <= 100; v += 25) {
      const y = T + ph - (v / 100) * ph;
      g.strokeStyle = grid; g.lineWidth = 1;
      g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
      g.fillStyle = muted; g.fillText(String(v), L - 6, y);
    }
    const n = data.length;
    const xAt = i => n === 1 ? L + pw / 2 : L + (i / (n - 1)) * pw;
    const yAt = v => T + ph - (Math.max(0, Math.min(100, v)) / 100) * ph;

    // fill + line
    const grad = g.createLinearGradient(0, T, 0, T + ph);
    grad.addColorStop(0, c.color + '55'); grad.addColorStop(1, c.color + '05');
    g.beginPath();
    data.forEach((p, i) => i ? g.lineTo(xAt(i), yAt(p.value)) : g.moveTo(xAt(i), yAt(p.value)));
    g.strokeStyle = c.color; g.lineWidth = 2; g.stroke();
    g.lineTo(xAt(n - 1), T + ph); g.lineTo(xAt(0), T + ph); g.closePath();
    g.fillStyle = grad; g.fill();
    if (n === 1) { g.beginPath(); g.arc(xAt(0), yAt(data[0].value), 3, 0, 7); g.fillStyle = c.color; g.fill(); }

    // x labels (about 6)
    g.fillStyle = muted; g.textAlign = 'center'; g.textBaseline = 'top';
    const step = Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i += step) g.fillText(fmt(data[i].ts, tab), xAt(i), T + ph + 8);

    // hover tooltip
    if (c.hover >= 0 && c.hover < n) {
      const p = data[c.hover], x = xAt(c.hover), y = yAt(p.value);
      g.strokeStyle = muted; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); g.setLineDash([]);
      g.beginPath(); g.arc(x, y, 4, 0, 7); g.fillStyle = c.color; g.fill();
      const txt = `${fmt(p.ts, tab)} - ${Number(p.value).toFixed(1)} %`;
      g.font = '11px "IBM Plex Mono", monospace';
      const tw = g.measureText(txt).width + 14;
      const bx = Math.min(Math.max(x - tw / 2, L), W - R - tw), by = Math.max(y - 30, T);
      g.fillStyle = cssVar('--bg-control'); g.strokeStyle = cssVar('--border-color');
      g.beginPath(); g.roundRect(bx, by, tw, 20, 4); g.fill(); g.stroke();
      g.fillStyle = cssVar('--text-main'); g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(txt, bx + 7, by + 10);
    }
  }
  const drawAll = () => { if (modal.classList.contains('show')) Object.values(charts).forEach(draw); };

  Object.values(charts).forEach(c => {
    c.canvas.addEventListener('mousemove', e => {
      const data = pts(c); if (!data.length) return;
      const r = c.canvas.getBoundingClientRect(), L = 32, R = 10, pw = r.width - L - R;
      const f = (e.clientX - r.left - L) / pw;
      c.hover = data.length === 1 ? 0 : Math.max(0, Math.min(data.length - 1, Math.round(f * (data.length - 1))));
      draw(c);
    });
    c.canvas.addEventListener('mouseleave', () => { c.hover = -1; draw(c); });
  });

  // ---- live data (board pushes every 5 s) ----
  function pushLive(c, msg) {
    if (!msg || msg.ts == null || msg.value == null) return;
    c.live.push({ ts: msg.ts, value: +msg.value });
    if (c.live.length > LIVE_MAX) c.live.shift();
  }
  function liveTick() {
    liveDot.classList.add('flash');
    clearTimeout(dotTimer);
    dotTimer = setTimeout(() => liveDot.classList.remove('flash'), 10000);
    if (tab === 'live') drawAll();
  }
  socket.on('cpu_usage', m => {
    pushLive(charts.cpu, m);
    if (m && m.value != null) document.getElementById('cpuTxt').textContent = `${Math.round(m.value)}%`;
    liveTick();
  });
  socket.on('memory_usage', m => {
    pushLive(charts.mem, m);
    if (m && m.used_gb != null) document.getElementById('ramTxt').textContent = `${m.used_gb.toFixed(2)}/${m.total_gb.toFixed(2)} GB`;
    liveTick();
  });

  // Sim mode: synthetic live data so the panel can be demoed without the board
  let simCpu = 12, simMem = 41;
  setInterval(() => {
    if (!isSimMode || isConnected) return;
    simCpu = Math.max(2, Math.min(95, simCpu + (Math.random() - 0.5) * 12));
    simMem = Math.max(20, Math.min(90, simMem + (Math.random() - 0.5) * 3));
    const ts = Date.now();
    pushLive(charts.cpu, { ts, value: simCpu });
    pushLive(charts.mem, { ts, value: simMem });
    if (tab === 'live') drawAll();
  }, 2000);

  // ---- history (REST on the board) ----
  async function fetchSamples(resource, start, win, keep) {
    try {
      const r = await fetch(`/get_samples/${resource}/${start}/${win}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      return Array.isArray(d) ? d.slice(-keep) : [];
    } catch (e) { return []; }
  }
  async function loadHistory(which) {
    const [start, win, keep] = which === '1h' ? ['-1h', '5m', 12] : ['-1d', '1h', 24];
    hint.textContent = 'Loading…';
    const [cpu, mem] = await Promise.all([
      fetchSamples('cpu', start, win, keep), fetchSamples('mem', start, win, keep)]);
    charts.cpu.hist[which] = cpu; charts.mem.hist[which] = mem;
    hint.textContent = which === '1h' ? 'Last hour, 5 minute averages.' : 'Last 24 hours, 1 hour averages.';
    if (tab === which) drawAll();
  }

  // ---- tabs / open / close ----
  document.querySelectorAll('.res-tab').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.res-tab').forEach(x => x.classList.toggle('active', x === b));
    tab = b.dataset.rtab;
    Object.values(charts).forEach(c => c.hover = -1);
    if (tab === 'live') hint.textContent = 'Live: sampled every 5 s from the UNO Q.';
    drawAll();
    if (tab !== 'live') loadHistory(tab);
  }));
  const open = () => { modal.classList.add('show'); modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => { drawAll(); if (tab !== 'live') loadHistory(tab); }); };
  const close = () => { modal.classList.remove('show'); modal.setAttribute('aria-hidden', 'true'); };
  document.getElementById('resBtn').addEventListener('click', open);
  document.getElementById('resClose').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  window.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  window.addEventListener('resize', drawAll);
  new MutationObserver(drawAll).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();