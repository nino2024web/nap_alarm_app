class AlarmsController < ApplicationController
  MAX_SECONDS = 24.hours.to_i

  def new
  end

  def create
    # タイマープリセット or customタイマー
    preset = params[:preset].presence
    custom_hours   = params[:custom_hours].to_i
    custom_minutes = params[:custom_minutes].to_i
    custom_seconds = params[:custom_seconds].to_i

    duration_seconds =
      case preset
      when "15" then 15.minutes
      when "20" then 20.minutes
      when "30" then 30.minutes
      when "45" then 45.minutes
      when "60" then 60.minutes
      when "custom"
      total = custom_hours.hours + custom_minutes.minutes + custom_seconds.seconds
      total = 0 if total.negative?
      total
      else
      0
      end

    duration_seconds = [ duration_seconds, MAX_SECONDS ].min
    if duration_seconds <= 0
      redirect_to root_path, alert: "0分は設定できません" and return
    end

    ends_at = Time.zone.now + duration_seconds
    music_url = params[:music_url].to_s

    redirect_to alarm_path(
      ends_at_ms: (ends_at.to_f * 1000).to_i,
      duration_ms: (duration_seconds * 1000),
      music_url: music_url
    )
  end

  def show
    # 必須パラメータがなければnewへ
    if params[:ends_at_ms].blank?
      redirect_to root_path, alert: "アラーム時間が見つからない。もう一回設定して。" and return
    end
  end
end
