class OembedsController < ApplicationController
  YT_HOSTS = %w[youtube.com www.youtube.com m.youtube.com youtu.be music.youtube.com].freeze

  def show
    url = params[:url].to_s
    u = URI.parse(url) rescue nil
    return render json: { error: "invalid url" }, status: 400 unless u&.is_a?(URI::HTTP)

    return render json: { error: "forbidden host" }, status: 400 unless YT_HOSTS.include?(u.host)

    # 正規化（youtu.be 短縮 → watch?v=）
    normalized = normalize_youtube(u)

    oembed_uri = URI.parse("https://www.youtube.com/oembed?format=json&url=#{CGI.escape(normalized)}")

    body = http_get(oembed_uri)
    data = JSON.parse(body)
    render json: {
      title: data["title"],
      author: data["author_name"],
      thumbnail_url: data["thumbnail_url"]
    }, status: 200
  rescue => e
    Rails.logger.warn("[oembed] #{e.class}: #{e.message}")
    render json: { error: "fetch failed" }, status: 502
  end

  private

  def http_get(uri)
    Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", read_timeout: 3, open_timeout: 3) do |http|
      req = Net::HTTP::Get.new(uri.request_uri)
      req["User-Agent"] = "NapAlarm/1.0"
      res = http.request(req)
      raise "bad status #{res.code}" unless res.is_a?(Net::HTTPSuccess)
      res.body
    end
  end

  def normalize_youtube(u)
    if u.host == "youtu.be"
      vid = u.path.delete_prefix("/")
      q = u.query.to_s
      params = Rack::Utils.parse_nested_query(q)
      params["v"] = vid
      "https://www.youtube.com/watch?#{params.to_query}"
    else
      u.to_s
    end
  end
end
