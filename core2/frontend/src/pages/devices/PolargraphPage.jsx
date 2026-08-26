import React, { useRef, useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import CommandPanel from '../../components/CommandPanel';

// Fallback px/mm and square size used only if the device hasn't announced
// motor_y/motor_dist yet.
const FALLBACK_SCALE = 0.3;
const FALLBACK_SIZE = 600;
const MAX_DIM = 600;  // longer canvas edge, in px
const PAD = 24;

// Polargraph device page: canvas with an orange dot at the calibrated
// origin (0,0) and a dot at the firmware's believed current position, jog
// controls, a single "set home" calibration button, and the generic
// command panel.
export default function PolargraphPage({ node, sendCommand, 
  drawSolarPath, cancelDrawing, error }) {
  const caps = node.capabilities || { publishes: [], subscribes: [] };
  const canvasRef = useRef(null);

  const telemetry = node.telemetry || {};
  const hasPosition = typeof telemetry.x === 'number' && typeof telemetry.y === 'number';
  const motorY = node.meta && typeof node.meta.motor_y === 'number' ? node.meta.motor_y : null;
  const motorDist = node.meta && typeof node.meta.motor_dist === 'number' ? node.meta.motor_dist : null;

  // Backend-orchestrated drawing job (currently just "solar_path") — see
  // drawing.py. null/undefined whenever nothing is running; the backend
  // clears it a moment after a job finishes or is cancelled, which is what
  // makes the line disappear on its own.
  const job = node.job;
  const isDrawing = !!job && job.status === 'running';

  // Green target dot from a canvas click, cleared once the reported
  // position gets close enough (or the arrival check has no way to fire,
  // if the device has never been zeroed — see effect below).
  const [target, setTarget] = useState(null);

  // Solar path scale — shrinks the traced shape toward the working
  // rectangle's center (see solar_path.py); 0.5 default so it doesn't fill
  // the whole frame edge-to-edge out of the box.
  const [solarScale, setSolarScale] = useState(0.5);

  // Which day's sun path to draw. Unchecked (the common case) means "use
  // today" — the date input still holds a value so it's ready to go the
  // moment the checkbox is ticked, but it's only actually sent to the
  // backend when useCustomDate is true (see drawSolarPath call below); the
  // backend defaults to today itself whenever no date param is present, so
  // there's no need to keep this in sync with "today" while unchecked.
  const [useCustomDate, setUseCustomDate] = useState(false);
  const [drawDate, setDrawDate] = useState(() => new Date().toISOString().slice(0, 10));

  // Pen-lift servo (P13, SERVO_SET {pos: raw value}) — the firmware clamps
  // whatever pos it's sent into [servoUp, servoWrite], so sending these
  // extreme values snaps onto the exact same up/write presets a boolean
  // toggle would have used; telemetry's servo_write is still a plain bool
  // (servoPos === the write preset exactly), so it's still a reliable
  // on/off read for this specific button, just not for PEN CAL below (an
  // in-between position won't match either preset, which is expected).
  const isWriting = telemetry.servo_write === true;

  // Placeholder — replace with whatever number calibration turns out to
  // need. Sent as-is via SERVO_SET {pos: ...}; since it's not one of the
  // toggle's extreme values, the firmware won't clamp it away as long as
  // it's within [servoUp, servoWrite].
  const PEN_CAL_POS = 86;

  // Canvas is sized to the real working rectangle (motorDist wide x motorY
  // tall), letterboxed within MAX_DIM so it's never stretched — 1mm is the
  // same number of px on both axes. Origin sits at top-middle (the ZERO
  // reference point): horizontally centered since motorDist spans evenly on
  // either side of x=0, at the top since y=0 is up near the motors.
  const { width, height, mapping } = useMemo(() => {
    if (!motorY || !motorDist) {
      const originX = FALLBACK_SIZE / 2;
      const originY = PAD;
      return {
        width: FALLBACK_SIZE,
        height: FALLBACK_SIZE,
        mapping: {
          toPixel: (x, y) => [originX - x * FALLBACK_SCALE, originY + y * FALLBACK_SCALE],
          toMm: (px, py) => [-(px - originX) / FALLBACK_SCALE, (py - originY) / FALLBACK_SCALE],
        },
      };
    }
    const scale = (MAX_DIM - 2 * PAD) / Math.max(motorDist, motorY);
    const w = motorDist * scale + 2 * PAD;
    const h = motorY * scale + 2 * PAD;
    const originX = w / 2;
    const originY = PAD;
    return {
      width: w,
      height: h,
      mapping: {
        toPixel: (x, y) => [originX - x * scale, originY + y * scale],
        toMm: (px, py) => [-(px - originX) / scale, (py - originY) / scale],
      },
    };
  }, [motorY, motorDist]);

  // -1/0/1 per motor. The firmware's WIND handler reads both l and r from
  // every command (defaulting anything missing to 0), so each click has to
  // resend the *combined* state, not just the motor that changed — that's
  // what lets L and R run independently/simultaneously.
  const [windL, setWindL] = useState(0);
  const [windR, setWindR] = useState(0);

  const jogL = (dir) => {
    const next = windL === dir ? 0 : dir;
    setWindL(next);
    sendCommand(node.device_id, 'WIND', { l: next, r: windR });
  };
  const jogR = (dir) => {
    const next = windR === dir ? 0 : dir;
    setWindR(next);
    sendCommand(node.device_id, 'WIND', { l: windL, r: next });
  };
  const haltJog = () => {
    setWindL(0);
    setWindR(0);
    // cancelDrawing sends HALT itself (which also clears the on-device
    // point queue) *and* cancels the backend job/clears its line — a plain
    // sendCommand(..., 'HALT') would stop the motors but leave the backend
    // job polling away, oblivious, and it'd just refill the queue and the
    // gondola would start moving again on its own a moment later.
    cancelDrawing(node.device_id);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, width, height);

    // Both axes are flipped relative to the firmware's raw x/y: confirmed
    // on the physical rig that moving up reads as -y (opposite of what the
    // geometry model assumes) and, via a click-target test (clicking left
    // of center should move the gondola left — it moved right instead,
    // confirmed after a clean backend/firmware restart), that +x also
    // needs mirroring. We flip here rather than in firmware, since
    // MOVE_ABS/HOME/calibration are internally consistent regardless of
    // what the firmware calls "+x"/"+y". toPixel/toMm share this exact
    // convention (see handleCanvasClick below), so a click target and the
    // live position dot can never visually disagree with each other by
    // construction — if either axis ever looks backward again, both
    // directions of that axis's mapping need to change together, and
    // solar_path.py's x formula (backend) needs to match too.
    const { toPixel } = mapping;
    const clampX = (v) => Math.max(4, Math.min(width - 4, v));
    const clampY = (v) => Math.max(4, Math.min(height - 4, v));

    // origin (0,0) — orange
    const [ox, oy] = toPixel(0, 0);
    const cox = clampX(ox);
    const coy = clampY(oy);
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cox, 0);
    ctx.lineTo(cox, height);
    ctx.moveTo(0, coy);
    ctx.lineTo(width, coy);
    ctx.stroke();

    ctx.fillStyle = '#f97316';
    ctx.beginPath();
    ctx.arc(cox, coy, 6, 0, Math.PI * 2);
    ctx.fill();

    // current position — cyan
    if (hasPosition) {
      const [px, py] = toPixel(telemetry.x, telemetry.y);
      ctx.fillStyle = '#22d3ee';
      ctx.beginPath();
      ctx.arc(clampX(px), clampY(py), 6, 0, Math.PI * 2);
      ctx.fill();
    }

    // click target — green, cleared once reached (see effect below)
    if (target) {
      const [tx, ty] = toPixel(target.x, target.y);
      ctx.fillStyle = '#22c55e';
      ctx.beginPath();
      ctx.arc(clampX(tx), clampY(ty), 6, 0, Math.PI * 2);
      ctx.fill();
    }

    // active drawing job — polyline, one segment per pair of consecutive
    // points, colored green if that segment's already been physically
    // reached (job.reached) or red if it's still ahead
    if (job && job.points && job.points.length > 1) {
      const pts = job.points.map(([x, y]) => toPixel(x, y).map((v, i) => (i === 0 ? clampX(v) : clampY(v))));
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      for (let i = 0; i < pts.length - 1; i++) {
        ctx.strokeStyle = i < job.reached ? '#22c55e' : '#ef4444';
        ctx.beginPath();
        ctx.moveTo(pts[i][0], pts[i][1]);
        ctx.lineTo(pts[i + 1][0], pts[i + 1][1]);
        ctx.stroke();
      }
    }
  }, [hasPosition, telemetry.x, telemetry.y, mapping, target, width, height, job]);

  // Clears the target dot once the gondola's reported position is close
  // enough to it — mirrors the firmware's own arrival check in
  // updatePath() (totalDist < 0.2mm), just with a looser tolerance since
  // this is only comparing telemetry snapshots, not live step counts.
  useEffect(() => {
    if (!target || !hasPosition) return;
    const dx = telemetry.x - target.x;
    const dy = telemetry.y - target.y;
    if (Math.sqrt(dx * dx + dy * dy) < 3) {
      setTarget(null);
    }
  }, [target, hasPosition, telemetry.x, telemetry.y]);

  const handleCanvasClick = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // canvas's internal pixel buffer (width/height) can render at a
    // different CSS size, so map the click through the actual displayed
    // rect rather than assuming a 1:1 pixel match.
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const py = ((e.clientY - rect.top) / rect.height) * height;
    let [x, y] = mapping.toMm(px, py);

    // The canvas element is padded (PAD px of margin) beyond the actual
    // motorDist x motorY working rectangle so the origin/edge dots aren't
    // drawn flush against the border — meaning a click can land in that
    // margin and produce an mm target physically outside the rig's real
    // travel. An open-loop stepper has no limit switches or encoders, so
    // asking it to go further than the strings can physically reach
    // doesn't error, it just stalls and silently loses steps, permanently
    // corrupting curX/curY (derived purely from commanded step counts)
    // until the next ZERO. Clamping here is what actually prevents that,
    // not just a cosmetic canvas-bounds nicety.
    if (motorY && motorDist) {
      x = Math.max(-motorDist / 2, Math.min(motorDist / 2, x));
      y = Math.max(0, Math.min(motorY, y));
    }

    setTarget({ x, y });
    sendCommand(node.device_id, 'MOVE_ABS', { x, y });
  };

  return (
    <div className="app device-page">
      <Link className="back-link" to="/devices">&larr; Back to devices</Link>

      <header className="header">
        <div>
          <h2>Polargraph <span className="device-id">{node.device_id}</span></h2>
          <div className={`status-badge ${node.online ? 'connected' : 'disconnected'}`}>
            {node.online ? 'Online' : 'Offline'}
          </div>
        </div>
      </header>

      {!isDrawing && (
        <div className="scale-control">
          <label htmlFor="solar-scale">Solar line scale</label>
          <input
            id="solar-scale"
            type="range"
            min="0.1"
            max="1"
            step="0.05"
            value={solarScale}
            onChange={(e) => setSolarScale(parseFloat(e.target.value))}
          />
          <span className="scale-value">{solarScale.toFixed(2)}</span>
        </div>
      )}

      {!isDrawing && (
        <div className="date-control">
          <input
            id="use-custom-date"
            type="checkbox"
            checked={useCustomDate}
            onChange={(e) => setUseCustomDate(e.target.checked)}
          />
          <label htmlFor="use-custom-date">Use date</label>
          <input
            id="solar-date"
            type="date"
            value={drawDate}
            disabled={!useCustomDate}
            onChange={(e) => setDrawDate(e.target.value)}
          />
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      <div className="canvas-toolbar">
        <button
          className="jog-btn set-home-btn"
          title="Jog the gondola to your fixed reference point (top-middle) first, then click this"
          onClick={() => sendCommand(node.device_id, 'ZERO', {})}
        >
          SET HOME
        </button>
        {isDrawing ? (
          <button className="jog-btn halt-btn set-home-btn" onClick={() => cancelDrawing(node.device_id)}>
            CANCEL DRAWING
          </button>
        ) : (
          <button
            className="jog-btn set-home-btn"
            onClick={() => drawSolarPath(node.device_id, solarScale, useCustomDate ? drawDate : null)}
          >
            DRAW SOLAR LINE
          </button>
        )}
      </div>

      {job && (
        <div className="job-status">
          {job.status === 'running'
            ? `Drawing solar path — ${job.reached}/${job.total} points reached`
            : 'Drawing complete'}
        </div>
      )}

      <div className="canvas-wrap">
        <canvas
          ref={canvasRef}
          className="polargraph-canvas"
          width={width}
          height={height}
          onClick={handleCanvasClick}
          title="Click to send the gondola here"
        />
      </div>

      <div className="jog-controls">
        <button className={`jog-btn ${windL === 1 ? 'active' : ''}`} onClick={() => jogL(1)}>LW</button>
        <button className={`jog-btn ${windL === -1 ? 'active' : ''}`} onClick={() => jogL(-1)}>LU</button>
        <button className="jog-btn halt-btn" onClick={haltJog}>HALT</button>
        <button className={`jog-btn ${windR === -1 ? 'active' : ''}`} onClick={() => jogR(-1)}>RU</button>
        <button className={`jog-btn ${windR === 1 ? 'active' : ''}`} onClick={() => jogR(1)}>RW</button>
      </div>

      <div className="servo-control">
        <button
          className={`jog-btn servo-toggle-btn ${isWriting ? 'active' : ''}`}
          onClick={() => sendCommand(node.device_id, 'SERVO_SET', { pos: isWriting ? 0 : 1000 })}
        >
          {isWriting ? 'WRITING' : 'PEN UP'}
        </button>
        <button
          className="jog-btn servo-toggle-btn"
          onClick={() => sendCommand(node.device_id, 'SERVO_SET', { pos: PEN_CAL_POS })}
        >
          PEN CAL
        </button>
      </div>

      <CommandPanel deviceId={node.device_id} capabilities={caps.subscribes} onCommand={sendCommand} />

      <div className="position-readout">
        <span><span className="dot-swatch origin-swatch" /> origin: 0, 0</span>
        <span>
          <span className="dot-swatch position-swatch" /> position:{' '}
          {hasPosition ? `${telemetry.x.toFixed(1)}, ${telemetry.y.toFixed(1)}` : 'not calibrated'}
        </span>
        {target && (
          <span>
            <span className="dot-swatch target-swatch" /> target: {target.x.toFixed(1)}, {target.y.toFixed(1)}
          </span>
        )}
      </div>
    </div>
  );
}
