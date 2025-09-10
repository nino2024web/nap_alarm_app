import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static values = { endsAt: Number, musicUrl: String };
  static targets = ["display", "audio"];

  connect() {
    // 状態
    this._timer = null;
    this._paused = true;
    this._wakeLock = null;
    this._ctx = null;
    this._osc = null;

    this._remainingMs = Math.max(0, this.endsAtValue - Date.now());
    this._render(this._remainingMs);

    // Audio 初期化
    this.audioTarget.loop = true;
    if (this.hasMusicUrlValue && this.musicUrlValue.trim() !== "") {
      this.audioTarget.src = this.musicUrlValue;
    }

    // 復帰時に Wake Lock を取り直す
    this._reacquireWakeLock = async () => {
      if (document.visibilityState === "visible" && !this._paused) {
        await this._requestWakeLock();
      }
    };
    document.addEventListener("visibilitychange", this._reacquireWakeLock);
  }

  disconnect() {
    this._clear();
    document.removeEventListener("visibilitychange", this._reacquireWakeLock);
    this._releaseWakeLock();
  }

  async start() {
    if (!this._paused) return;
    this._paused = false;
    this._endsAtMs = Date.now() + this._remainingMs;

    this._clear();
    this._tick();
    this._timer = setInterval(() => this._tick(), 200);

    // クリック直後＝ユーザー操作のうちに要求
    await this._requestWakeLock();
  }

  async pause() {
    if (this._paused) return;
    this._paused = true;
    this._clear();
    this._remainingMs = Math.max(0, this._endsAtMs - Date.now());
    this._render(this._remainingMs);
    await this._releaseWakeLock();
  }

  async reset() {
    this._paused = true;
    this._clear();
    this._remainingMs = Math.max(0, this.endsAtValue - Date.now());
    this._render(this._remainingMs);
    this._stopSound();
    await this._releaseWakeLock();
  }

  async testSound() {
    try {
      await this._ensureAudioUnlocked();
      await this._playSoundOnce();
    } catch (e) {
      alert("再生がブロックされたかも。別のURLやブラウザを試して。");
      console.error(e);
    }
  }

  _tick() {
    const ms = Math.max(0, this._endsAtMs - Date.now());
    this._remainingMs = ms;
    this._render(ms);

    if (ms <= 0) {
      this._clear();
      this._ring();
    }
  }

  _render(ms) {
    const totalSec = Math.ceil(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    this.displayTarget.textContent = [h, m, s]
      .map((v) => String(v).padStart(2, "0"))
      .join(":");
  }

  async _ring() {
    try {
      await this._ensureAudioUnlocked();
      if (!this.hasMusicUrlValue || this.musicUrlValue.trim() === "") {
        await this._beepPattern();
      } else {
        await this.audioTarget.play();
      }
    } catch (e) {
      this.displayTarget.textContent = "再生ボタン押して！";
    }
  }

  _clear() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _stopSound() {
    try {
      this.audioTarget.pause();
      this.audioTarget.currentTime = 0;
    } catch (_) {}
    if (this._osc) {
      this._osc.stop();
      this._osc.disconnect();
      this._osc = null;
    }
    if (this._ctx) {
      this._ctx.close().catch(() => {});
      this._ctx = null;
    }
  }

  async _ensureAudioUnlocked() {
    // クリック経由の呼び出しがあれば大抵OK
    return Promise.resolve();
  }

  async _playSoundOnce() {
    if (this.hasMusicUrlValue && this.musicUrlValue.trim() !== "") {
      this._stopSound();
      await this.audioTarget.play();
    } else {
      await this._beepOnce();
    }
  }

  async _beepOnce(duration = 800, freq = 880) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this._ctx = ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    osc.start();
    this._osc = osc;
    await new Promise((res) => setTimeout(res, duration));
    osc.stop();
    osc.disconnect();
    gain.disconnect();
    await ctx.close();
    this._osc = null;
    this._ctx = null;
  }

  async _beepPattern() {
    for (let i = 0; i < 6; i++) {
      await this._beepOnce(250, 1000);
      await new Promise((res) => setTimeout(res, 120));
    }
  }

  // ---- Wake Lock ----
  async _requestWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        // 既存があれば一旦解放してから（ブラウザ差異ケア）
        if (this._wakeLock) {
          await this._wakeLock.release().catch(() => {});
          this._wakeLock = null;
        }
        this._wakeLock = await navigator.wakeLock.request("screen");
        this._wakeLock.addEventListener("release", () => {
          // 必要ならここでUI通知
        });
      }
    } catch (e) {
      console.warn("Wake Lock 拒否/失敗:", e);
    }
  }

  async _releaseWakeLock() {
    try {
      await this._wakeLock?.release();
    } catch (_) {}
    this._wakeLock = null;
  }
}
