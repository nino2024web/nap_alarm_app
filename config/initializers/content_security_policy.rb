# Be sure to restart your server when you modify this file.

Rails.application.configure do
  config.content_security_policy do |policy|
    # ベース
    policy.default_src :self, :https
    policy.font_src    :self, :https, :data
    policy.object_src  :none
    policy.media_src   :self, :https
    policy.connect_src :self, :https, "https://www.youtube.com", "https://www.google.com"
    policy.directives["style-src-attr"] = [ "'unsafe-inline'" ]
    policy.style_src_attr :unsafe_inline

    # 画像（YouTubeサムネ等）
    policy.img_src     :self, :https, :data, "https://i.ytimg.com", "https://yt3.ggpht.com"

    # スクリプト／フレーム（YouTube/IFrame API）
    policy.script_src  :self, :https, "https://www.youtube.com", "https://s.ytimg.com"
    policy.frame_src   :self, :https, "https://www.youtube.com", "https://www.youtube-nocookie.com"


      policy.style_src :self, :https
  end

  # （必要なら）nonce を有効化 — importmap/inline を安全に通す
  config.content_security_policy_nonce_generator  = ->(request) { request.session.id.to_s }
  config.content_security_policy_nonce_directives = %w[script-src style-src]
  # config.content_security_policy_report_only = true
end
