// ==================== STATE ====================
    let isSimMode = false;
    let isConnected = false;
    const socket = io();
    let lastTelem = null;

    // Rover state
    let roverState = { dir: 'STOP', vx: 0, vy: 0, rpmL: 0, rpmR: 0 };

    // 3-DOF Arm state
    let armCur = { base: 90, shoulder: 115, elbow: 75 };
    let armTgt = { base: 90, shoulder: 115, elbow: 75 };
    let isAutoSpraying = false;
    let sprayParticles = [];

    // Camera & CNN Inference state
    let currentLeafSample = 'early_blight';
    const SAMPLE_KEYS = ['early_blight', 'powdery_mildew', 'healthy'];
    let simSampleIdx = 0;
    let uploadedLeafImg = null;
    let webcamStream = null;
    let isWebcamActive = false;
    let scanLaserY = -1;
    let detectedBBox = null;

    const LEAF_SAMPLES = {
      early_blight: {
        title: 'Early Blight',
        conf: 94.6,
        probs: { eb: 94.6, lb: 3.1, pm: 1.4, hl: 0.9 },
        sprayMs: 2500,
        bbox: { x: 145, y: 44, w: 148, h: 92, color: '#EF4444' }
      },
      powdery_mildew: {
        title: 'Powdery Mildew',
        conf: 91.8,
        probs: { eb: 4.2, lb: 2.5, pm: 91.8, hl: 1.5 },
        sprayMs: 2200,
        bbox: { x: 138, y: 40, w: 160, h: 96, color: '#F59E0B' }
      },
      healthy: {
        title: 'Healthy Foliage',
        conf: 98.4,
        probs: { eb: 0.6, lb: 0.4, pm: 0.6, hl: 98.4 },
        sprayMs: 0,
        bbox: { x: 105, y: 32, w: 215, h: 118, color: '#10B981' }
      }
    };

    // ==================== UTILITIES ====================
    function logSerial(msg) {
      document.getElementById('serialLogTxt').textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    }

    let toastTimer = null;
    function requireActiveHardware() {
      if (isConnected || isSimMode) return true;
      const t = document.getElementById('toastAlert');
      t.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
      return false;
    }

    // Send one event to the board. `type` is the Socket.IO event name.
    function sendWS(payload, quiet = false) {
      const { type, ...data } = payload;
      if (isConnected) socket.emit(type, data);
      if (!quiet) logSerial(`TX ${type} ${JSON.stringify(data)}`);
    }

    // ==================== SIM MODE & THEME ====================
    const simToggle = document.getElementById('simToggle');
    const simLabel = document.getElementById('simLabel');

    simToggle.addEventListener('click', () => {
      isSimMode = !isSimMode;
      simToggle.classList.toggle('active', isSimMode);
      simLabel.textContent = isSimMode ? 'Sim Mode: ON' : 'Sim Mode: OFF';
      if (!isSimMode && !isConnected) {
        roverState = { dir: 'STOP', vx: 0, vy: 0, rpmL: 0, rpmR: 0 };
        isAutoSpraying = false;
        detectedBBox = null;
      }
      logSerial(isSimMode ? '[SIM] Active' : '[SIM] Disabled');
    });

    document.getElementById('themeBtn').addEventListener('click', () => {
      const html = document.documentElement;
      html.setAttribute('data-theme', html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });

    // ==================== SOCKET.IO CONNECTION ====================
    const linkPill = document.getElementById('linkPill');
    const linkTxt = document.getElementById('linkTxt');
    const connectBtn = document.getElementById('connectBtn');

    function setLink(up, text) {
      isConnected = up;
      linkPill.classList.toggle('up', up);
      linkTxt.textContent = text;
    }

    socket.on('connect', () => { setLink(true, 'UNO Q linked'); logSerial('Connected'); });
    socket.on('disconnect', () => {
      setLink(false, 'Link lost');
      stopDriveLocal();
      logSerial('Link lost - rover stops after 0.5 s without commands');
    });
    socket.on('connect_error', () => setLink(false, 'Connecting…'));

    connectBtn.addEventListener('click', () => {
      if (socket.connected) socket.disconnect();
      setTimeout(() => socket.connect(), 150);
    });

    socket.on('telemetry', t => {
      lastTelem = t;
      if (t.battery != null) document.getElementById('batTxt').textContent = `BAT ${Math.round(t.battery)}%`;
      if (t.heading != null) document.getElementById('hdgTxt').textContent = `HDG ${Math.round(t.heading)}°`;
      if (!isSimMode && t.rpm) {
        roverState.rpmL = t.rpm[0]; roverState.rpmR = t.rpm[1];
        document.getElementById('rpmLeftTxt').textContent = `L: ${Math.round(t.rpm[0])} RPM`;
        document.getElementById('rpmRightTxt').textContent = `R: ${Math.round(t.rpm[1])} RPM`;
      }
    });
    socket.on('log', m => logSerial(m));
    socket.on('arm_state', a => { /* optional: reflect real servo angles */ });
    socket.on('cnn_result', data => applyCNNResult(data));

    // ==================== PANEL 1: ROVER LOCOMOTION ====================
    // Board watchdog stops the rover if no "drive" arrives for 0.5 s,
    // so we re-send the current command at 10 Hz while it is non-zero.
    let driveCmd = { linear: 0, angular: 0 };
    let driveTimer = null;

    function pushDrive() {
      if (isConnected) socket.emit('drive', driveCmd);
    }
    function setDriveCmd(linear, angular) {
      driveCmd = { linear, angular };
      pushDrive();
      const moving = linear !== 0 || angular !== 0;
      if (moving && !driveTimer) driveTimer = setInterval(pushDrive, 100);
      if (!moving && driveTimer) { clearInterval(driveTimer); driveTimer = null; }
    }
    function stopDriveLocal() {
      setDriveCmd(0, 0);
      roverState = { dir: 'STOP', vx: 0, vy: 0, rpmL: 0, rpmR: 0 };
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
      document.getElementById('roverVecTxt').textContent = dir;
      setDriveCmd(lin, ang);
    }

    function emergencyStop() {
      stopDriveLocal();
      if (isConnected) socket.emit('estop', {});
      logSerial('E-STOP sent');
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
      if (heldKeys.size) setRoverDrive(KEYDIR[[...heldKeys].pop()]);   // fall back to still-held key
      else setRoverDrive('STOP');
    });
    // Never keep driving if the tab loses focus
    window.addEventListener('blur', () => { heldKeys.clear(); if (driveTimer) emergencyStop(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && driveTimer) emergencyStop(); });

    // Proportional Joystick
    const joyBase = document.getElementById('joyBase');
    const joyStick = document.getElementById('joyStick');
    let joyDragging = false;

    function handleJoyMove(clientX, clientY) {
      if (!joyDragging) return;
      if (!requireActiveHardware()) { joyDragging = false; return; }
      const rect = joyBase.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const maxR = 37;
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
      document.getElementById('joyDeg').textContent = `${deg}°`;

      roverState.vx = nx;
      roverState.vy = ny;
      roverState.rpmL = Math.round((ny + nx * 0.7) * 130);
      roverState.rpmR = Math.round((ny - nx * 0.7) * 130);
      roverState.dir = Math.hypot(nx, ny) > 0.1 ? 'VECTOR' : 'STOP';

      document.getElementById('rpmLeftTxt').textContent = `L: ${roverState.rpmL} RPM`;
      document.getElementById('rpmRightTxt').textContent = `R: ${roverState.rpmR} RPM`;
      document.getElementById('roverVecTxt').textContent = `${nx.toFixed(1)}, ${ny.toFixed(1)}`;
      setDriveCmd(ny, -nx);   // linear = forward, angular = left
    }

    function resetJoystick() {
      if (!joyDragging) return;
      joyDragging = false;
      joyStick.style.transform = `translate(0px, 0px)`;
      document.getElementById('joyX').textContent = `X: 0.00`;
      document.getElementById('joyY').textContent = `Y: 0.00`;
      document.getElementById('joyDeg').textContent = `0°`;
      if (isConnected || isSimMode) setRoverDrive('STOP');
    }

    joyBase.addEventListener('pointerdown', (e) => { joyDragging = true; joyBase.setPointerCapture(e.pointerId); handleJoyMove(e.clientX, e.clientY); });
    window.addEventListener('pointermove', (e) => handleJoyMove(e.clientX, e.clientY));
    window.addEventListener('pointerup', resetJoystick);
    window.addEventListener('pointercancel', resetJoystick);

    // ==================== PANEL 2: 3-DOF ARM KINEMATICS ====================
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

    function updateArmTarget(base, shoulder, elbow) {
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
      document.getElementById('armHeaderAngleTxt').textContent = `J1: ${armTgt.base}° · J2: ${armTgt.shoulder}° · J3: ${armTgt.elbow}°`;
      document.getElementById('yawChip').textContent = `Azimuth: ${armTgt.base}°`;
      sendArmThrottled();
    }

    [sBase, sShoulder, sElbow].forEach(el => {
      el.addEventListener('input', () => updateArmTarget(sBase.value, sShoulder.value, sElbow.value));
    });

    // ==================== PANEL 3: CAMERA & CNN INFERENCE ====================
    const webcamBtn = document.getElementById('webcamBtn');
    const webcamVideo = document.getElementById('webcamVideo');

    webcamBtn.addEventListener('click', async () => {
      if (isWebcamActive) {
        if (webcamStream) webcamStream.getTracks().forEach(t => t.stop());
        isWebcamActive = false;
        webcamBtn.classList.remove('active');
        document.getElementById('camSourceStatus').textContent = 'Optical Feed';
        return;
      }
      try {
        webcamStream = await navigator.mediaDevices.getUserMedia({ video: { width: 420, height: 185 } });
        webcamVideo.srcObject = webcamStream;
        isWebcamActive = true;
        uploadedLeafImg = null;
        detectedBBox = null;
        webcamBtn.classList.add('active');
        document.getElementById('camSourceStatus').textContent = 'Live Camera';
      } catch (err) {
        logSerial('Camera access unavailable');
      }
    });

    document.getElementById('leafUpload').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (isWebcamActive && webcamStream) {
        webcamStream.getTracks().forEach(t => t.stop());
        isWebcamActive = false;
        webcamBtn.classList.remove('active');
      }
      const img = new Image();
      img.onload = () => {
        uploadedLeafImg = img;
        detectedBBox = null;
        document.getElementById('camSourceStatus').textContent = 'Uploaded Frame';
      };
      img.src = URL.createObjectURL(file);
    });

    function setPipelineStep(stepNum) {
      [1,2,3,4].forEach(n => {
        document.getElementById(`step${n}`).classList.toggle('active', n <= stepNum);
      });
    }

    function applyCNNResult(resData) {
      // Accept both client (sprayMs/title) and board (spray_ms/label) key styles
      if (resData.sprayMs == null) resData.sprayMs = resData.spray_ms || 0;
      if (!resData.title) resData.title = resData.label || 'Result';
      if (resData.bbox) detectedBBox = resData.bbox;
      else if (!detectedBBox) {
        const known = Object.values(LEAF_SAMPLES).find(s => s.title === resData.title);
        if (known) detectedBBox = known.bbox;
      }
      scanLaserY = -1;
      setPipelineStep(3);
      document.getElementById('confPctTxt').textContent = `${Math.round(resData.conf)}%`;
      const offset = 201 - (201 * resData.conf) / 100;
      const arc = document.getElementById('confArc');
      arc.style.strokeDashoffset = offset;
      arc.style.stroke = resData.sprayMs > 0 ? '#F59E0B' : '#10B981';

      document.getElementById('diseaseNameTxt').textContent = resData.title;
      document.getElementById('pctEB').textContent = `${resData.probs.eb.toFixed(1)}%`;
      document.getElementById('barEB').style.width = `${resData.probs.eb}%`;
      document.getElementById('pctLB').textContent = `${resData.probs.lb.toFixed(1)}%`;
      document.getElementById('barLB').style.width = `${resData.probs.lb}%`;
      document.getElementById('pctPM').textContent = `${resData.probs.pm.toFixed(1)}%`;
      document.getElementById('barPM').style.width = `${resData.probs.pm}%`;
      document.getElementById('pctHL').textContent = `${resData.probs.hl.toFixed(1)}%`;
      document.getElementById('barHL').style.width = `${resData.probs.hl}%`;

      setTimeout(() => {
        setPipelineStep(4);
        const banner = document.getElementById('nozzleBanner');
        const stateTxt = document.getElementById('nozzleStateTxt');

        if (resData.sprayMs > 0) {
          updateArmTarget(90, 70, 96);
          isAutoSpraying = true;
          banner.className = 'nozzle-auto-banner spraying';
          stateTxt.textContent = `Active Spray (${(resData.sprayMs / 1000).toFixed(1)}s)`;
          logSerial(`CNN [${resData.title}] -> <SPRY:AUTO,${resData.sprayMs}>`);

          setTimeout(() => {
            isAutoSpraying = false;
            banner.className = 'nozzle-auto-banner';
            stateTxt.textContent = 'Standby';
          }, resData.sprayMs);
        } else {
          isAutoSpraying = false;
          banner.className = 'nozzle-auto-banner bypassed';
          stateTxt.textContent = 'Bypassed (Healthy)';
          logSerial(`CNN [Healthy] -> <SPRY:SKIP,0>`);
        }
      }, 300);
    }

    document.getElementById('scanLeafBtn').addEventListener('click', () => {
      if (!requireActiveHardware()) return;
      detectedBBox = null;
      scanLaserY = 0;
      setPipelineStep(1);

      if (!uploadedLeafImg && !isWebcamActive) {
        currentLeafSample = SAMPLE_KEYS[simSampleIdx];
        simSampleIdx = (simSampleIdx + 1) % SAMPLE_KEYS.length;
      }

      updateArmTarget(90, 86, 108);
      const source = isWebcamActive ? 'webcam' : (uploadedLeafImg ? 'upload' : 'arm_camera');
      setTimeout(() => setPipelineStep(2), 400);

      if (isConnected && !isSimMode) {
        // Real inference on the board. Send a frame if the browser has one.
        let image = null;
        if (source !== 'arm_camera') {
          const c = document.createElement('canvas');
          c.width = 224; c.height = 224;
          const src = source === 'webcam' ? webcamVideo : uploadedLeafImg;
          try { c.getContext('2d').drawImage(src, 0, 0, 224, 224); image = c.toDataURL('image/jpeg', 0.8); } catch (e) {}
        }
        socket.emit('cnn_predict', { source, image });
        logSerial('TX cnn_predict ' + source);
      } else {
        setTimeout(() => {
          setPipelineStep(3);
          const res = LEAF_SAMPLES[currentLeafSample];
          detectedBBox = res.bbox;
          scanLaserY = -1;
          applyCNNResult(res);
        }, 1150);
      }
    });

    // ==================== 60FPS INDUSTRIAL RENDERERS ====================
    const roverCanvas = document.getElementById('roverCanvas');
    const rCtx = roverCanvas.getContext('2d');
    const armCanvas = document.getElementById('armCanvas');
    const aCtx = armCanvas.getContext('2d');
    const leafCanvas = document.getElementById('leafCanvas');
    const lCtx = leafCanvas.getContext('2d');

    // 1. ROVER RENDERER
    function drawRoverCanvas() {
      const W = roverCanvas.width, H = roverCanvas.height;
      rCtx.clearRect(0, 0, W, H);

      rCtx.strokeStyle = 'rgba(16, 185, 129, 0.14)';
      rCtx.setLineDash([6, 6]);
      rCtx.beginPath();
      rCtx.moveTo(95, 0); rCtx.lineTo(95, H);
      rCtx.moveTo(W - 95, 0); rCtx.lineTo(W - 95, H);
      rCtx.stroke();
      rCtx.setLineDash([]);

      const cx = W / 2, cy = H / 2 + 6;
      rCtx.save();
      rCtx.translate(cx, cy);

      // Heavy Industrial Tracks
      [-58, 38].forEach((tx, idx) => {
        const trackGrad = rCtx.createLinearGradient(tx, 0, tx + 20, 0);
        trackGrad.addColorStop(0, '#0F172A');
        trackGrad.addColorStop(0.5, '#1E293B');
        trackGrad.addColorStop(1, '#0F172A');
        rCtx.fillStyle = trackGrad;
        rCtx.strokeStyle = '#334155';
        rCtx.lineWidth = 1.5;
        rCtx.beginPath();
        rCtx.roundRect(tx, -48, 20, 96, 4);
        rCtx.fill();
        rCtx.stroke();

        // Tread cleats
        rCtx.strokeStyle = '#00979D';
        rCtx.lineWidth = 2;
        const rpm = (isConnected || isSimMode) ? (idx === 0 ? roverState.rpmL : roverState.rpmR) : 0;
        const off = ((Date.now() * rpm * 0.0035) % 12 + 12) % 12;
        for (let y = -42 + off; y < 44; y += 12) {
          rCtx.beginPath();
          rCtx.moveTo(tx + 3, y);
          rCtx.lineTo(tx + 17, y);
          rCtx.stroke();
        }
      });

      // Suspension Bogie Arms
      rCtx.strokeStyle = '#475569';
      rCtx.lineWidth = 3;
      [-38, 38].forEach(sx => {
        rCtx.beginPath();
        rCtx.moveTo(sx, -24); rCtx.lineTo(sx < 0 ? -38 : 38, -24);
        rCtx.stroke();
      });

      // Main Armored Hull
      const hullGrad = rCtx.createLinearGradient(-38, -42, 38, 42);
      hullGrad.addColorStop(0, '#1E293B');
      hullGrad.addColorStop(0.5, '#0F172A');
      hullGrad.addColorStop(1, '#151E28');
      rCtx.fillStyle = hullGrad;
      rCtx.strokeStyle = '#00979D';
      rCtx.lineWidth = 1.8;
      rCtx.beginPath();
      rCtx.roundRect(-38, -42, 76, 84, 6);
      rCtx.fill();
      rCtx.stroke();

      // Top Machined Payload Plate
      rCtx.fillStyle = 'rgba(0, 151, 157, 0.12)';
      rCtx.strokeStyle = '#2A3A48';
      rCtx.lineWidth = 1;
      rCtx.beginPath();
      rCtx.roundRect(-28, -28, 56, 56, 4);
      rCtx.fill();
      rCtx.stroke();

      // Turret Ring
      rCtx.strokeStyle = '#00B5BC';
      rCtx.lineWidth = 1.5;
      rCtx.beginPath();
      rCtx.arc(0, 0, 14, 0, Math.PI * 2);
      rCtx.stroke();

      // Active Sonar Waves
      if ((isConnected || isSimMode) && (Math.abs(roverState.rpmL) > 0 || Math.abs(roverState.rpmR) > 0)) {
        rCtx.strokeStyle = 'rgba(0, 181, 188, 0.45)';
        rCtx.lineWidth = 1.2;
        for (let r = 12; r <= 30; r += 9) {
          rCtx.beginPath();
          rCtx.arc(0, -45, r, -Math.PI * 0.72, -Math.PI * 0.28);
          rCtx.stroke();
        }
      }
      rCtx.restore();
    }

    // 2. REALISTIC CNC 3-DOF ROBOTIC ARM RENDERER
    function drawMetallicLink(ctx, x1, y1, x2, y2, wStart, wEnd) {
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);

      ctx.save();
      ctx.translate(x1, y1);
      ctx.rotate(ang);

      // Drop shadow
      ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 4;

      // Machined Aluminum Body
      const grad = ctx.createLinearGradient(0, -wStart / 2, 0, wStart / 2);
      grad.addColorStop(0, '#475569');
      grad.addColorStop(0.25, '#64748B');
      grad.addColorStop(0.55, '#334155');
      grad.addColorStop(1, '#1E293B');

      ctx.fillStyle = grad;
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, -wStart / 2);
      ctx.lineTo(len, -wEnd / 2);
      ctx.lineTo(len, wEnd / 2);
      ctx.lineTo(0, wStart / 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      // Recessed CNC Weight-Relief Pocket
      if (len > 38) {
        ctx.fillStyle = '#0F172A';
        ctx.strokeStyle = 'rgba(0, 181, 188, 0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(14, -wStart * 0.24, len - 28, wStart * 0.48, 3);
        ctx.fill();
        ctx.stroke();
      }

      ctx.restore();
    }

    function drawServoJoint(ctx, x, y, radius) {
      ctx.save();
      ctx.translate(x, y);

      // Outer Harmonic Housing
      const jGrad = ctx.createRadialGradient(-2, -2, 2, 0, 0, radius);
      jGrad.addColorStop(0, '#475569');
      jGrad.addColorStop(0.7, '#1E293B');
      jGrad.addColorStop(1, '#0F172A');
      ctx.fillStyle = jGrad;
      ctx.strokeStyle = '#00B5BC';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Socket Cap Bolts
      ctx.fillStyle = '#94A3B8';
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * (radius * 0.65), Math.sin(a) * (radius * 0.65), 1.3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Center Encoder Cap
      ctx.fillStyle = '#00979D';
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.3, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    function drawArmCanvas() {
      const W = armCanvas.width, H = armCanvas.height;
      aCtx.clearRect(0, 0, W, H);

      if (isConnected || isSimMode) {
        armCur.base += (armTgt.base - armCur.base) * 0.12;
        armCur.shoulder += (armTgt.shoulder - armCur.shoulder) * 0.12;
        armCur.elbow += (armTgt.elbow - armCur.elbow) * 0.12;
      }

      const baseX = 165, baseY = H - 24;

      // Ground Horizon Line
      aCtx.strokeStyle = '#222D36';
      aCtx.lineWidth = 1.5;
      aCtx.beginPath();
      aCtx.moveTo(20, baseY + 14);
      aCtx.lineTo(W - 20, baseY + 14);
      aCtx.stroke();

      // Bolted Rover Deck Flange
      const baseGrad = aCtx.createLinearGradient(baseX - 52, baseY, baseX + 52, baseY + 14);
      baseGrad.addColorStop(0, '#1E293B');
      baseGrad.addColorStop(0.5, '#334155');
      baseGrad.addColorStop(1, '#0F172A');
      aCtx.fillStyle = baseGrad;
      aCtx.strokeStyle = '#475569';
      aCtx.lineWidth = 1.5;
      aCtx.beginPath();
      aCtx.roundRect(baseX - 50, baseY, 100, 14, 3);
      aCtx.fill();
      aCtx.stroke();

      // Rotary Azimuth Turret (J1)
      const turretGrad = aCtx.createLinearGradient(baseX - 24, baseY - 18, baseX + 24, baseY);
      turretGrad.addColorStop(0, '#334155');
      turretGrad.addColorStop(0.5, '#64748B');
      turretGrad.addColorStop(1, '#1E293B');
      aCtx.fillStyle = turretGrad;
      aCtx.strokeStyle = '#00979D';
      aCtx.beginPath();
      aCtx.roundRect(baseX - 24, baseY - 16, 48, 16, 3);
      aCtx.fill();
      aCtx.stroke();

      // Kinematics Calculation
      const L1 = 74, L2 = 66;
      const shRad = (-armCur.shoulder * Math.PI) / 180;
      const j0x = baseX, j0y = baseY - 16;
      const j1x = j0x + Math.cos(shRad) * L1;
      const j1y = j0y + Math.sin(shRad) * L1;

      const elRad = shRad + ((90 - armCur.elbow) * Math.PI) / 180;
      const j2x = j1x + Math.cos(elRad) * L2;
      const j2y = j1y + Math.sin(elRad) * L2;

      const reachMm = Math.round(Math.hypot(j2x - j0x, j2y - j0y) * 2.1);
      document.getElementById('reachChip').textContent = `Reach: ${reachMm} mm`;

      // External Braided Cable Loop
      aCtx.strokeStyle = '#00979D';
      aCtx.lineWidth = 2.2;
      aCtx.beginPath();
      aCtx.moveTo(j0x - 14, j0y);
      aCtx.quadraticCurveTo(j1x - 28, j1y - 18, j2x - 6, j2y);
      aCtx.stroke();

      // Render Metallic Links
      drawMetallicLink(aCtx, j0x, j0y, j1x, j1y, 18, 14);
      drawMetallicLink(aCtx, j1x, j1y, j2x, j2y, 14, 11);

      // Render Harmonic Servo Joints
      drawServoJoint(aCtx, j0x, j0y, 11);
      drawServoJoint(aCtx, j1x, j1y, 9.5);
      drawServoJoint(aCtx, j2x, j2y, 7.5);

      // Functional End-Effector Assembly (Optical Camera + Brass Piezo Nozzle)
      aCtx.save();
      aCtx.translate(j2x, j2y);
      aCtx.rotate(elRad);

      // Optical Camera FOV Frustum
      const fovGrad = aCtx.createLinearGradient(18, 0, 88, 0);
      fovGrad.addColorStop(0, 'rgba(56, 189, 248, 0.24)');
      fovGrad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');
      aCtx.fillStyle = fovGrad;
      aCtx.beginPath();
      aCtx.moveTo(20, -4);
      aCtx.lineTo(88, -28);
      aCtx.lineTo(88, 20);
      aCtx.closePath();
      aCtx.fill();

      // Anodized Vision Camera Enclosure
      aCtx.fillStyle = '#1E293B';
      aCtx.strokeStyle = '#94A3B8';
      aCtx.lineWidth = 1.2;
      aCtx.beginPath();
      aCtx.roundRect(4, -11, 20, 14, 3);
      aCtx.fill();
      aCtx.stroke();

      // Multi-coated Camera Objective Lens
      aCtx.fillStyle = '#0284C7';
      aCtx.strokeStyle = '#38BDF8';
      aCtx.beginPath();
      aCtx.arc(24, -4, 4, -Math.PI / 2, Math.PI / 2);
      aCtx.fill();
      aCtx.stroke();

      // Brass Agricultural Sprinkling Nozzle Assembly
      aCtx.fillStyle = '#D97706';
      aCtx.strokeStyle = '#FBBF24';
      aCtx.lineWidth = 1;
      aCtx.beginPath();
      aCtx.roundRect(6, 4, 16, 6, 2);
      aCtx.fill();
      aCtx.stroke();

      // Nozzle Atomizer Orifice Tip
      aCtx.fillStyle = '#F59E0B';
      aCtx.beginPath();
      aCtx.moveTo(22, 4);
      aCtx.lineTo(27, 5.5);
      aCtx.lineTo(27, 8.5);
      aCtx.lineTo(22, 10);
      aCtx.closePath();
      aCtx.fill();

      aCtx.restore();

      // Atomized Spray Particle Physics
      if (isAutoSpraying && (isConnected || isSimMode)) {
        const nozX = j2x + Math.cos(elRad) * 26;
        const nozY = j2y + Math.sin(elRad) * 26;
        for (let i = 0; i < 4; i++) {
          const spread = (Math.random() - 0.5) * 0.42;
          const spd = 3.2 + Math.random() * 2.4;
          sprayParticles.push({
            x: nozX,
            y: nozY,
            vx: Math.cos(elRad + spread) * spd,
            vy: Math.sin(elRad + spread) * spd,
            r: 1.5 + Math.random() * 1.5,
            alpha: 0.95
          });
        }
      }

      for (let i = sprayParticles.length - 1; i >= 0; i--) {
        const p = sprayParticles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.07;
        p.alpha -= 0.026;
        if (p.alpha <= 0) {
          sprayParticles.splice(i, 1);
          continue;
        }
        aCtx.fillStyle = `rgba(16, 185, 129, ${p.alpha})`;
        aCtx.beginPath();
        aCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        aCtx.fill();
      }
    }

    // 3. REALISTIC BOTANICAL LEAF & PATHOLOGY RENDERER
    function drawBotanicalLeaf(ctx, sampleKey) {
      ctx.save();

      // Petiole Stem
      ctx.strokeStyle = '#3F6212';
      ctx.lineWidth = 4.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(72, 98);
      ctx.quadraticCurveTo(92, 96, 112, 92);
      ctx.stroke();

      // Natural Serrated Leaf Contour
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 6;

      const leafGrad = ctx.createLinearGradient(105, 30, 325, 150);
      if (sampleKey === 'early_blight') {
        leafGrad.addColorStop(0, '#2E6F21');
        leafGrad.addColorStop(0.55, '#1E5618');
        leafGrad.addColorStop(1, '#3B5314');
      } else if (sampleKey === 'powdery_mildew') {
        leafGrad.addColorStop(0, '#285E28');
        leafGrad.addColorStop(0.6, '#1F4E24');
        leafGrad.addColorStop(1, '#163A1B');
      } else {
        leafGrad.addColorStop(0, '#228B22');
        leafGrad.addColorStop(0.5, '#15803D');
        leafGrad.addColorStop(1, '#14532D');
      }

      ctx.fillStyle = leafGrad;
      ctx.beginPath();
      ctx.moveTo(108, 92);
      ctx.bezierCurveTo(135, 38, 225, 24, 328, 86);
      ctx.bezierCurveTo(235, 162, 138, 146, 108, 92);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Clip to Leaf Lamina for Venation & Pathology
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(108, 92);
      ctx.bezierCurveTo(135, 38, 225, 24, 328, 86);
      ctx.bezierCurveTo(235, 162, 138, 146, 108, 92);
      ctx.closePath();
      ctx.clip();

      // Cuticle Specular Highlight
      const sheen = ctx.createRadialGradient(185, 62, 8, 195, 72, 95);
      sheen.addColorStop(0, 'rgba(255, 255, 255, 0.12)');
      sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = sheen;
      ctx.fillRect(100, 20, 240, 150);

      // Primary Midrib Vein
      ctx.strokeStyle = 'rgba(163, 230, 53, 0.55)';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(108, 92);
      ctx.quadraticCurveTo(215, 86, 324, 86);
      ctx.stroke();

      // Secondary Lateral Veins
      ctx.strokeStyle = 'rgba(163, 230, 53, 0.32)';
      ctx.lineWidth = 1.3;
      const veins = [
        [142, 91, 165, 62, 192, 46],
        [178, 89, 205, 58, 238, 46],
        [218, 88, 244, 64, 274, 56],
        [258, 87, 278, 72, 298, 68],
        [146, 91, 172, 118, 204, 134],
        [186, 89, 214, 120, 248, 132],
        [226, 88, 252, 114, 282, 120]
      ];
      veins.forEach(([x0, y0, cx, cy, x1, y1]) => {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(cx, cy, x1, y1);
        ctx.stroke();
      });

      // Realistic Pathology Lesions
      if (sampleKey === 'early_blight') {
        const spots = [
          { x: 192, y: 74, r: 17 },
          { x: 242, y: 102, r: 14 },
          { x: 168, y: 108, r: 11 },
          { x: 222, y: 66, r: 9 }
        ];
        spots.forEach(s => {
          // Chlorotic Yellow Halo
          const halo = ctx.createRadialGradient(s.x, s.y, s.r * 0.3, s.x, s.y, s.r * 1.65);
          halo.addColorStop(0, 'rgba(202, 138, 4, 0.75)');
          halo.addColorStop(0.6, 'rgba(234, 179, 8, 0.35)');
          halo.addColorStop(1, 'rgba(234, 179, 8, 0)');
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r * 1.65, 0, Math.PI * 2);
          ctx.fill();

          // Irregular Necrotic Core
          ctx.fillStyle = '#451A03';
          ctx.beginPath();
          ctx.ellipse(s.x, s.y, s.r, s.r * 0.82, 0.35, 0, Math.PI * 2);
          ctx.fill();

          // Concentric Targetoid Alternaria Rings
          ctx.strokeStyle = '#78350F';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.ellipse(s.x, s.y, s.r * 0.68, s.r * 0.55, 0.35, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.ellipse(s.x, s.y, s.r * 0.36, s.r * 0.28, 0.35, 0, Math.PI * 2);
          ctx.stroke();
        });
      } else if (sampleKey === 'powdery_mildew') {
        const patches = [
          { x: 185, y: 72, r: 24 },
          { x: 238, y: 96, r: 22 },
          { x: 162, y: 104, r: 18 },
          { x: 262, y: 74, r: 15 }
        ];
        patches.forEach(p => {
          const mildew = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, p.r);
          mildew.addColorStop(0, 'rgba(241, 245, 249, 0.82)');
          mildew.addColorStop(0.55, 'rgba(203, 213, 225, 0.48)');
          mildew.addColorStop(1, 'rgba(148, 163, 184, 0)');
          ctx.fillStyle = mildew;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
        });
      }

      ctx.restore();
      ctx.restore();
    }

    function drawLeafCanvas() {
      const W = leafCanvas.width, H = leafCanvas.height;
      lCtx.clearRect(0, 0, W, H);

      if (isWebcamActive && webcamVideo.readyState >= 2) {
        lCtx.drawImage(webcamVideo, 0, 0, W, H);
      } else if (uploadedLeafImg) {
        lCtx.drawImage(uploadedLeafImg, 0, 0, W, H);
      } else {
        drawBotanicalLeaf(lCtx, currentLeafSample);
      }

      // Active CNN Laser Sweep
      if (scanLaserY >= 0) {
        scanLaserY = (scanLaserY + 3.4) % H;
        lCtx.strokeStyle = '#00B5BC';
        lCtx.lineWidth = 2;
        lCtx.beginPath();
        lCtx.moveTo(0, scanLaserY);
        lCtx.lineTo(W, scanLaserY);
        lCtx.stroke();
      }

      // ROI Classification Bounding Box
      if (detectedBBox) {
        lCtx.strokeStyle = detectedBBox.color;
        lCtx.lineWidth = 1.8;
        lCtx.strokeRect(detectedBBox.x, detectedBBox.y, detectedBBox.w, detectedBBox.h);

        const label = LEAF_SAMPLES[currentLeafSample].title;
        lCtx.fillStyle = 'rgba(11, 15, 19, 0.88)';
        lCtx.fillRect(detectedBBox.x, detectedBBox.y - 18, 118, 16);
        lCtx.fillStyle = detectedBBox.color;
        lCtx.font = '600 10.5px IBM Plex Mono';
        lCtx.fillText(label, detectedBBox.x + 5, detectedBBox.y - 6);
      }
    }

    function animateLoop() {
      drawRoverCanvas();
      drawArmCanvas();
      drawLeafCanvas();
      requestAnimationFrame(animateLoop);
    }
    animateLoop();