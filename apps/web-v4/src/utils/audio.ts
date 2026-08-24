// Web Audio API synthesizer for UI sound effects & music box melody

class SoundManager {
  private ctx: AudioContext | null = null;
  private isMuted: boolean = false;
  private melodyTimer: ReturnType<typeof setInterval> | null = null;
  private isPlayingMelody: boolean = false;

  constructor() {
    // 从 localStorage 恢复静音状态（跨会话持久化）
    try {
      this.isMuted = localStorage.getItem('idate_sound_muted') === '1';
    } catch {
      this.isMuted = false;
    }
  }

  private initCtx() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  public setMuted(muted: boolean) {
    this.isMuted = muted;
    try {
      localStorage.setItem('idate_sound_muted', muted ? '1' : '0');
    } catch {
      // storage 不可用时静默忽略
    }
    if (muted && this.isPlayingMelody) {
      this.stopLoverMelody();
    }
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  // Soft water ripple bubble sound
  public playWaterRipple() {
    if (this.isMuted) return;
    try {
      this.initCtx();
      if (!this.ctx) return;

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      const now = this.ctx.currentTime;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(450, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);

      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.18);
    } catch {
      // Audio context might be restricted before user interaction
    }
  }

  // Heart affection level up chime
  public playAffectionGain() {
    if (this.isMuted) return;
    try {
      this.initCtx();
      if (!this.ctx) return;

      const now = this.ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6

      notes.forEach((freq, idx) => {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + idx * 0.08);

        gain.gain.setValueAtTime(0.06, now + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.25);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.25);
      });
    } catch {
      // Audio fallback
    }
  }

  // Message incoming bubble ping
  public playMessagePing() {
    if (this.isMuted) return;
    try {
      this.initCtx();
      if (!this.ctx) return;

      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, now);
      osc.frequency.setValueAtTime(800, now + 0.06);

      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.15);
    } catch {
      // Audio fallback
    }
  }

  // Play Lover Romantic Music Box Melody
  public playLoverMelody(onNote?: (noteIndex: number) => void) {
    if (this.isMuted) return;
    this.stopLoverMelody();
    this.isPlayingMelody = true;
    this.initCtx();
    if (!this.ctx) return;

    // Sweet romantic melody notes (Lover music box arpeggio: C4, E4, G4, B4, C5, A4, G4, E4)
    const frequencies = [
      523.25, 659.25, 783.99, 987.77,
      1046.50, 880.00, 783.99, 659.25,
      587.33, 698.46, 880.00, 1046.50,
      880.00, 783.99, 659.25, 523.25,
    ];

    let step = 0;
    const playNote = () => {
      if (!this.ctx || !this.isPlayingMelody) return;
      const freq = frequencies[step % frequencies.length];
      const now = this.ctx.currentTime;

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      // Music box bell timbre
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);

      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.45);

      if (onNote) onNote(step % frequencies.length);
      step++;
    };

    playNote();
    this.melodyTimer = setInterval(playNote, 420);
  }

  public stopLoverMelody() {
    this.isPlayingMelody = false;
    if (this.melodyTimer) {
      clearInterval(this.melodyTimer);
      this.melodyTimer = null;
    }
  }

  public getIsPlayingMelody(): boolean {
    return this.isPlayingMelody;
  }

  // Heartbeat sound effect
  public playHeartbeat() {
    if (this.isMuted) return;
    try {
      this.initCtx();
      if (!this.ctx) return;

      const now = this.ctx.currentTime;
      [0, 0.2].forEach((offset) => {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(75, now + offset);
        osc.frequency.exponentialRampToValueAtTime(45, now + offset + 0.1);

        gain.gain.setValueAtTime(0.18, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.14);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(now + offset);
        osc.stop(now + offset + 0.14);
      });
    } catch {
      // Audio fallback
    }
  }
}


export const soundManager = new SoundManager();

