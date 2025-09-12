import { Controller } from "@hotwired/stimulus"

const KEY = "nap_alarm_history" // [{duration_ms, music_url, at}]

export default class extends Controller {
  static targets = ["musicUrl","historyList"]

  connect() {
    this.audio = null
    this.ctx = null
    // 最寄りの form にぶら下げて submit 時に履歴保存
    this.formEl = this.element.closest("form") || this.element.querySelector("form")
    this._onSubmit = () => this.saveHistory()
    if (this.formEl) this.formEl.addEventListener("submit", this._onSubmit)
    this.renderHistory()
  }

  disconnect() {
    if (this.formEl && this._onSubmit) this.formEl.removeEventListener("submit", this._onSubmit)
    this.stopTest()
  }

  // ===== テスト再生 =====
  testSound() {
    const url = this.musicUrlTarget?.value?.trim() || ""
    this.stopTest()
    if (!url) return this._beepOnce()

    try {
      const a = new Audio()
      a.crossOrigin = "anonymous"  // 先に指定（善）
      a.src = url                  // 後でセット
      this.audio = a
      a.play().catch(() => this._beepOnce())
    } catch { this._beepOnce() }
  }

  stopTest() {
    if (this.audio) { try { this.audio.pause() } catch(_){} this.audio.src = ""; this.audio = null }
    if (this.ctx)   { try { this.ctx.close() } catch(_){} this.ctx = null }
  }

  _beepOnce(duration = 500, freq = 880) {
    const AC = window.AudioContext || window.webkitAudioContext
    this.ctx = new AC()
    const osc = this.ctx.createOscillator(), gain = this.ctx.createGain()
    osc.type = "sine"; osc.frequency.value = freq
    osc.connect(gain); gain.connect(this.ctx.destination)
    gain.gain.setValueAtTime(0.001, this.ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.3, this.ctx.currentTime + 0.01)
    osc.start()
    setTimeout(() => {
      try { osc.stop(); osc.disconnect(); gain.disconnect() } catch {}
      this.ctx.close().catch(()=>{}); this.ctx = null
    }, duration)
  }

  // ===== 直近10件 =====
  saveHistory() {
    const ms  = this._currentDurationMs()
    const url = (this.musicUrlTarget?.value || "").trim()
    const item = { duration_ms: ms, music_url: url, at: Date.now() }

    const list = this._load()
    const key  = it => `${it.duration_ms}|${it.music_url}`
    const seen = new Set([key(item)])
    const out  = [item]
    for (const it of list) {
      const k = key(it); if (seen.has(k)) continue
      seen.add(k); out.push(it); if (out.length >= 10) break
    }
    localStorage.setItem(KEY, JSON.stringify(out))
  }

  clearHistory() {
    localStorage.removeItem(KEY)
    this.renderHistory()
  }

  renderHistory() {
    const list = this._load()
    this.historyListTarget.innerHTML = ""
    if (!list.length) {
      this.historyListTarget.insertAdjacentHTML("beforeend",
        `<li class="text-sm text-gray-600">履歴はありません</li>`)
      return
    }
    for (const it of list) {
      const mins = Math.floor(it.duration_ms / 60000)
      const secs = Math.floor((it.duration_ms % 60000) / 1000)
      const label = `${mins}分${secs ? secs + "秒" : ""} / ${it.music_url || "ビープ"}`
      const li = document.createElement("li")
      li.className = "flex items-center gap-2"
      li.innerHTML = `
        <button type="button" class="inline-flex items-center justify-center rounded border px-3 py-1 hover:bg-gray-50">
          使う
        </button>
        <span class="text-sm">${label}</span>`
      li.querySelector("button").addEventListener("click", () => this._apply(it))
      this.historyListTarget.appendChild(li)
    }
  }

  _apply(it) {
    // preset/custom の切替と数値の復元
    const presets = [15,20,30,45,60]
    const totalMin = Math.round(it.duration_ms / 60000)
    const match = presets.find(m => m === totalMin)

    if (match) {
      const r = document.querySelector(`input[name="preset"][value="${match}"]`)
      if (r) r.checked = true
      const ch = document.querySelector('input[name="custom_hours"]')
      const cm = document.querySelector('input[name="custom_minutes"]')
      if (ch) ch.value = 0
      if (cm) cm.value = 0
    } else {
      const r = document.querySelector('input[name="preset"][value="custom"]')
      if (r) r.checked = true
      const hours = Math.floor(it.duration_ms / 3600000)
      const minutes = Math.floor((it.duration_ms % 3600000) / 60000)
      const ch = document.querySelector('input[name="custom_hours"]')
      const cm = document.querySelector('input[name="custom_minutes"]')
      if (ch) ch.value = hours
      if (cm) cm.value = minutes
    }

    const mu = document.querySelector('input[name="music_url"]')
    if (mu) mu.value = it.music_url || ""
  }

  _currentDurationMs() {
    const checked = document.querySelector('input[name="preset"]:checked')?.value
    if (checked && checked !== "custom") return parseInt(checked, 10) * 60000

    const h = parseInt(document.querySelector('input[name="custom_hours"]')?.value || "0", 10)
    const m = parseInt(document.querySelector('input[name="custom_minutes"]')?.value || "0", 10)
    let ms = ((isNaN(h)?0:h) * 60 + (isNaN(m)?0:m)) * 60000
    const max = 24 * 60 * 60000
    if (ms < 0) ms = 0
    if (ms > max) ms = max
    return ms
  }

  _load() {
    try { return JSON.parse(localStorage.getItem(KEY) || "[]") } catch { return [] }
  }
}
