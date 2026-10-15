import * as THREE from 'three';
import { LIVERIES, buildMicroKart } from '../scene/MicroKartBuilder.js';

/**
 * High-Performance AI Rival Car Manager
 * Simulates 3 AI competitors racing alongside the player with 1:87 micro realism,
 * authentic racing lines, slipstreaming, overtaking, dynamic drift sparks, and live leaderboard.
 */
export function createRivalCarManager({
  scene,
  sparkScene,
  splineData,
  sampleTrackAtArcLength,
  playerLiveryId = 'red_apex',
}) {
  const totalLength = splineData.total_length_m || 3.8371;
  const samples = splineData.samples;
  const N = samples.length;

  // Locate the Start/Finish line anchor (sample 646 in Sector 6)
  let startFinishIdx = Math.min(646, N - 1);
  const startFinishSample = samples[startFinishIdx] || samples[0];
  const startGridS = startFinishSample.arc_length_m;

  // Grid offsets relative to player's starting line:
  // Slot 1: Pole Position (Rival 1, +0.038m ahead, right lane)
  // Slot 2: Player (at startGridS, center lane)
  // Slot 3: Grid 3 (Rival 2, -0.038m behind, left lane)
  // Slot 4: Grid 4 (Rival 3, -0.076m behind, right lane)
  const gridSlots = [
    { sOffset: +0.038, latOffset: +0.0035 },
    { sOffset: -0.038, latOffset: -0.0035 },
    { sOffset: -0.076, latOffset: +0.0030 },
  ];

  // AI Rival Personalities
  const aiProfiles = [
    {
      baseSpeed: 0.218,
      maxSpeed: 0.252,
      cornerSpeed: 0.175,
      accel: 2.8,
      laneBias: +0.0025,
      aggression: 0.92,
    },
    {
      baseSpeed: 0.212,
      maxSpeed: 0.246,
      cornerSpeed: 0.170,
      accel: 3.2,
      laneBias: -0.0025,
      aggression: 0.88,
    },
    {
      baseSpeed: 0.208,
      maxSpeed: 0.240,
      cornerSpeed: 0.168,
      accel: 2.6,
      laneBias: +0.0018,
      aggression: 0.82,
    },
  ];

  // Pick 3 rival liveries excluding the player's chosen livery
  function pickRivalLiveries(currentPlLiveryId) {
    const pool = LIVERIES.filter((l) => l.id !== currentPlLiveryId);
    return [pool[0] || LIVERIES[1], pool[1] || LIVERIES[2], pool[2] || LIVERIES[3]];
  }

  let cachedGlbScene = null;
  const rivals = [];

  const initialRivalLiveries = pickRivalLiveries(playerLiveryId);

  for (let i = 0; i < 3; i++) {
    const livery = initialRivalLiveries[i];
    const profile = aiProfiles[i];
    const grid = gridSlots[i];

    const kart = buildMicroKart(livery);
    kart.kartRoot.scale.setScalar(0.38);
    scene.add(kart.kartRoot);
    if (sparkScene && kart.sparkPoints) {
      sparkScene.add(kart.sparkPoints);
    }

    const rival = {
      id: `rival_${i + 1}`,
      index: i,
      name: `${livery.name} #${livery.number}`,
      livery,
      profile,
      kart,
      initialGrid: grid,
      s: (startGridS + grid.sOffset + totalLength) % totalLength,
      lateralOffset: grid.latOffset,
      targetLateral: grid.latOffset,
      speed: 0.0,
      targetSpeed: 0.0,
      steerAngle: 0.0,
      isDrifting: false,
      driftAngle: 0.0,
      boostActive: 0.0,
      hopHeight: 0.0,
      lapCount: 1,
      currentLapTime: 0.0,
      totalTime: 0.0,
      lapTimes: [],
      raceFinished: false,
      finishTime: null,
      bestLapTime: null,
      state: {
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        tangent: new THREE.Vector3(),
        normal: new THREE.Vector3(),
        right: new THREE.Vector3(),
        speed: 0.0,
        steerAngle: 0.0,
        steerInput: 0.0,
        isDrifting: false,
        driftAngle: 0.0,
        boostActive: 0.0,
        hopHeight: 0.0,
        curbRumble: 0.0,
      },
    };

    rivals.push(rival);
  }

  // Pre-allocated math objects for zero-GC 60fps simulation
  const _sampleTrack = {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    right: new THREE.Vector3(),
    bankDeg: 0,
    signedCurvature: 0,
    slope: 0,
  };
  const _rotMatrix = new THREE.Matrix4();
  const _steerForward = new THREE.Vector3();
  const _steerRight = new THREE.Vector3();

  // Reset all rivals to their grid spots
  function reset() {
    for (let i = 0; i < rivals.length; i++) {
      const r = rivals[i];
      r.s = (startGridS + r.initialGrid.sOffset + totalLength) % totalLength;
      r.lateralOffset = r.initialGrid.latOffset;
      r.targetLateral = r.initialGrid.latOffset;
      r.speed = 0.0;
      r.targetSpeed = 0.0;
      r.steerAngle = 0.0;
      r.isDrifting = false;
      r.driftAngle = 0.0;
      r.boostActive = 0.0;
      r.lapCount = 1;
      r.currentLapTime = 0.0;
      r.totalTime = 0.0;
      r.lapTimes = [];
      r.raceFinished = false;
      r.finishTime = null;
      r.bestLapTime = null;

      sampleTrackAtArcLength(r.s, _sampleTrack);
      r.state.position
        .copy(_sampleTrack.position)
        .addScaledVector(_sampleTrack.right, r.lateralOffset)
        .addScaledVector(_sampleTrack.normal, 0.0012);
      r.state.tangent.copy(_sampleTrack.tangent);
      r.state.normal.copy(_sampleTrack.normal);
      r.state.right.copy(_sampleTrack.right);
      r.state.speed = 0.0;
      r.state.steerAngle = 0.0;
      r.state.steerInput = 0.0;
      r.state.isDrifting = false;
      r.state.boostActive = 0.0;

      _steerForward.copy(_sampleTrack.tangent);
      _steerRight.copy(_sampleTrack.right);
      _rotMatrix.makeBasis(_steerRight, _sampleTrack.normal, _steerForward);
      r.state.quaternion.setFromRotationMatrix(_rotMatrix);

      r.kart.kartRoot.position.copy(r.state.position);
      r.kart.kartRoot.quaternion.copy(r.state.quaternion);
      r.kart.updateWheels(0.016, 0.0, 0.0);
      r.kart.updateKartVisuals(0.016, r.state);
    }
  }

  // Update player livery and reassign non-player liveries to rivals
  function updatePlayerLivery(newPlayerLiveryId) {
    const newRivalLiveries = pickRivalLiveries(newPlayerLiveryId);
    for (let i = 0; i < rivals.length; i++) {
      const r = rivals[i];
      const newLivery = newRivalLiveries[i];
      r.livery = newLivery;
      r.name = `${newLivery.name} #${newLivery.number}`;
      r.kart.setLivery(newLivery);
      if (cachedGlbScene) {
        r.kart.attachGlbKart(cachedGlbScene, newLivery);
      }
    }
  }

  // Attach GLB model to all rival karts when loaded
  function attachGlbToRivals(glbScene) {
    cachedGlbScene = glbScene;
    for (let i = 0; i < rivals.length; i++) {
      const r = rivals[i];
      r.kart.attachGlbKart(glbScene, r.livery);
    }
  }

  // Synchronize scale across all rival karts (e.g. for camera modes 1..4)
  function syncScale(targetScale) {
    for (let i = 0; i < rivals.length; i++) {
      rivals[i].kart.kartRoot.scale.setScalar(targetScale);
    }
  }

  // Main 60FPS update loop for AI Rivals
  function update(dt, playerState, raceClockActive, countdownLocked) {
    const clampedDt = Math.min(0.05, Math.max(0.001, dt));

    for (let i = 0; i < rivals.length; i++) {
      const r = rivals[i];

      if (countdownLocked) {
        // Locked on starting grid
        r.speed = 0.0;
        r.targetSpeed = 0.0;
        r.state.speed = 0.0;
        r.state.boostActive = 0.0;
        r.state.isDrifting = false;
        sampleTrackAtArcLength(r.s, _sampleTrack);
        r.state.position
          .copy(_sampleTrack.position)
          .addScaledVector(_sampleTrack.right, r.lateralOffset)
          .addScaledVector(_sampleTrack.normal, 0.0012);
        _rotMatrix.makeBasis(_sampleTrack.right, _sampleTrack.normal, _sampleTrack.tangent);
        r.state.quaternion.setFromRotationMatrix(_rotMatrix);
        r.kart.kartRoot.position.copy(r.state.position);
        r.kart.kartRoot.quaternion.copy(r.state.quaternion);
        r.kart.updateWheels(clampedDt, 0.0, 0.0);
        r.kart.updateKartVisuals(clampedDt, r.state);
        continue;
      }

      if (raceClockActive && !r.raceFinished) {
        r.currentLapTime += clampedDt;
        r.totalTime += clampedDt;
      }

      // Sample track geometry at rival's current arc-length
      sampleTrackAtArcLength(r.s, _sampleTrack);
      const curvature = _sampleTrack.signedCurvature || 0.0;
      const absCurv = Math.abs(curvature);

      // AI Target Speed & Drift Decision
      if (absCurv > 0.022) {
        // Cornering: brake into the turn and take racing apex
        r.targetSpeed = r.profile.cornerSpeed;
        const insideApex = -Math.sign(curvature) * (0.0042 + r.profile.laneBias);
        r.targetLateral = THREE.MathUtils.lerp(r.targetLateral, insideApex, clampedDt * 2.5);

        if (absCurv > 0.034) {
          r.isDrifting = true;
          r.driftAngle = -Math.sign(curvature) * 0.22;
          r.steerAngle = -Math.sign(curvature) * 0.38;
        } else {
          r.isDrifting = false;
          r.driftAngle = 0.0;
          r.steerAngle = -Math.sign(curvature) * 0.22;
        }
      } else {
        // Straight: accelerate to top speed & drift recovery
        r.targetSpeed = r.profile.maxSpeed;
        r.isDrifting = false;
        r.driftAngle = 0.0;
        r.steerAngle = THREE.MathUtils.lerp(r.steerAngle, 0.0, clampedDt * 5.0);
        r.targetLateral = THREE.MathUtils.lerp(r.targetLateral, r.profile.laneBias, clampedDt * 1.5);
      }

      // Tactical AI: Slipstreaming & Overtaking the Player
      if (playerState && raceClockActive) {
        const distToPlayer = (playerState.s - r.s + totalLength) % totalLength;
        const playerIsAhead = distToPlayer > 0 && distToPlayer < 0.12;

        if (playerIsAhead) {
          // In slipstream: gain a draft boost!
          r.targetSpeed += 0.018 * r.profile.aggression;

          // If within 0.06m behind player, attempt a dynamic lane pass
          if (distToPlayer < 0.065) {
            const playerLat = playerState.lateralOffset || 0.0;
            // Dive into the opposite lane of the player
            r.targetLateral = playerLat >= 0 ? -0.0045 : +0.0045;
          }
        }
      }

      // Rival-to-Rival Lane Separation (prevent identical overlap)
      for (let j = 0; j < rivals.length; j++) {
        if (i === j) continue;
        const other = rivals[j];
        const distOther = (other.s - r.s + totalLength) % totalLength;
        if (distOther > 0 && distOther < 0.045) {
          if (Math.abs(r.targetLateral - other.lateralOffset) < 0.003) {
            r.targetLateral = other.lateralOffset > 0 ? -0.0042 : +0.0042;
          }
        }
      }

      // Smooth Acceleration
      const accelRate = r.targetSpeed > r.speed ? r.profile.accel : r.profile.accel * 1.4;
      r.speed += (r.targetSpeed - r.speed) * Math.min(1.0, clampedDt * accelRate);

      // Advance along spline
      const prevS = r.s;
      r.s = (r.s + r.speed * clampedDt) % totalLength;

      // Lap Detection
      if (prevS > totalLength - 0.45 && r.s < 0.45 && raceClockActive) {
        r.lapTimes.push(r.currentLapTime);
        if (r.bestLapTime === null || r.currentLapTime < r.bestLapTime) {
          r.bestLapTime = r.currentLapTime;
        }
        r.currentLapTime = 0.0;
        r.lapCount += 1;

        if (r.lapCount > 3) {
          r.raceFinished = true;
          r.finishTime = r.totalTime;
        }
      }

      // Smooth Lateral Steering
      r.lateralOffset += (r.targetLateral - r.lateralOffset) * Math.min(1.0, clampedDt * 2.8);
      r.lateralOffset = THREE.MathUtils.clamp(r.lateralOffset, -0.0065, +0.0065);

      // Update 3D World Transform
      r.state.position
        .copy(_sampleTrack.position)
        .addScaledVector(_sampleTrack.right, r.lateralOffset)
        .addScaledVector(_sampleTrack.normal, 0.0012 + r.hopHeight);

      r.state.tangent.copy(_sampleTrack.tangent);
      r.state.normal.copy(_sampleTrack.normal);
      r.state.right.copy(_sampleTrack.right);
      r.state.speed = r.speed;
      r.state.steerAngle = r.steerAngle;
      r.state.steerInput = -r.steerAngle / 0.45;
      r.state.isDrifting = r.isDrifting;
      r.state.driftAngle = r.driftAngle;
      r.state.boostActive = r.boostActive > 0 ? (r.boostActive -= clampedDt) : 0.0;

      // Compute heading rotation with banking and steering yaw
      _steerForward
        .copy(_sampleTrack.tangent)
        .applyAxisAngle(_sampleTrack.normal, r.steerAngle * 0.15)
        .normalize();
      _steerRight.crossVectors(_steerForward, _sampleTrack.normal).normalize();

      _rotMatrix.makeBasis(_steerRight, _sampleTrack.normal, _steerForward);
      r.state.quaternion.setFromRotationMatrix(_rotMatrix);

      // Apply to Three.js kart hierarchy
      r.kart.kartRoot.position.copy(r.state.position);
      r.kart.kartRoot.quaternion.copy(r.state.quaternion);
      r.kart.updateWheels(clampedDt, r.speed, r.steerAngle);
      r.kart.updateKartVisuals(clampedDt, r.state);
    }
  }

  // Calculate live race standings across all 4 racers (Player + 3 Rivals)
  function getStandings(playerState) {
    const list = [];

    // Player entry
    const plLap = playerState.lapCount || 1;
    const plS = playerState.s || 0.0;
    const plProgress = plLap * totalLength + plS;
    list.push({
      id: 'player',
      isPlayer: true,
      name: 'YOU (PLAYER)',
      livery: LIVERIES.find((l) => l.id === playerLiveryId) || LIVERIES[0],
      lap: plLap,
      s: plS,
      progress: plProgress,
      totalTime: playerState.totalRaceTime || 0.0,
      finishTime: playerState.finishTotalTime,
      finished: Boolean(playerState.raceFinished),
    });

    // 3 Rival entries
    for (let i = 0; i < rivals.length; i++) {
      const r = rivals[i];
      const rProgress = r.lapCount * totalLength + r.s;
      list.push({
        id: r.id,
        isPlayer: false,
        name: r.name,
        livery: r.livery,
        lap: r.lapCount,
        s: r.s,
        progress: rProgress,
        totalTime: r.totalTime,
        finishTime: r.finishTime,
        finished: r.raceFinished,
      });
    }

    // Sort descending by total progress
    list.sort((a, b) => b.progress - a.progress);

    // Assign rank 1..4 and calculate gaps
    const leaderProgress = list[0].progress;
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      item.rank = rank + 1;
      const diffMeters = leaderProgress - item.progress;
      if (rank === 0) {
        item.gapText = 'LEADER';
      } else {
        // Average speed approx 0.21 m/s -> time gap in seconds
        const gapSec = diffMeters / 0.21;
        item.gapText = `+${gapSec.toFixed(1)}s`;
      }
    }

    return list;
  }

  // Get current player rank and gap text
  function getPlayerPosition(playerState) {
    const standings = getStandings(playerState);
    const pl = standings.find((s) => s.isPlayer);
    return {
      rank: pl ? pl.rank : 1,
      totalRacers: 4,
      gapText: pl ? pl.gapText : 'LEADER',
      standings,
    };
  }

  // Initialize starting positions immediately
  reset();

  return {
    rivals,
    update,
    reset,
    syncScale,
    attachGlbToRivals,
    updatePlayerLivery,
    getStandings,
    getPlayerPosition,
  };
}
