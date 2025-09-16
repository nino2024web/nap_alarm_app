require "net/http"
require "uri"
require "json"
require "cgi"
class OembedsController < ApplicationController
  class HttpError < StandardError
    attr_reader :code, :body
    def initialize(code, body) = (@code = code; @body = body; super("HTTP #{code}"))
  end

  def show
    raw = params[:url].to_s
    u = URI.parse(raw) rescue nil
    return render json: { error: "invalid url" }, status: 400 unless u.is_a?(URI::HTTP)

    watch = canonical_watch_url(u)
    return render json: { error: "invalid video id" }, status: 422 if watch.nil?

    data = oembed!(watch) # ← ここで例外 or Hash
    render json: {
      title: data["title"],
      author: data["author_name"],
      thumbnail_url: data["thumbnail_url"]
    }, status: 200

  rescue HttpError => e
        case e.code
        when 401, 403, 404
      Rails.logger.warn("[oembed] upstream=#{e.code} body=#{e.body&.byteslice(0, 180)}")
      render json: { error: "unavailable", upstream: e.code }, status: 422
        when 429
      Rails.logger.warn("[oembed] rate limited (429)")
      render json: { error: "rate_limited" }, status: 429
        else
      Rails.logger.warn("[oembed] upstream=#{e.code} body=#{e.body&.byteslice(0, 180)}")
      render json: { error: "upstream_error", upstream: e.code }, status: 502
        end
  rescue JSON::ParserError => e
    Rails.logger.warn("[oembed] JSON error: #{e.message}")
    render json: { error: "bad_response" }, status: 502
  rescue => e
    Rails.logger.warn("[oembed] #{e.class}: #{e.message}")
    render json: { error: "fetch_failed" }, status: 502
  end

  private

  def oembed!(watch_url)
    uri = URI("https://www.youtube.com/oembed?format=json&url=#{CGI.escape(watch_url)}")
    body = http_get!(uri) # ここで HttpError が飛ぶことがある
    JSON.parse(body)
  end

  def http_get!(uri, limit = 3)
    raise HttpError.new(599, "too many redirects") if limit <= 0

    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = (uri.scheme == "https")
    http.open_timeout = 5
    http.read_timeout = 5
    http.write_timeout = 5 if http.respond_to?(:write_timeout)

    req = Net::HTTP::Get.new(uri.request_uri)
    req["User-Agent"] = "NapAlarm/1.0 (+oembed)"
    req["Accept"] = "application/json"

    res = http.request(req)
    case res
    when Net::HTTPSuccess
      res.body
    when Net::HTTPRedirection
      http_get!(URI.join(uri, res["location"]), limit - 1)
    else
      # 上流のコードと本文を持ったまま投げ返す
      raise HttpError.new(res.code.to_i, res.body.to_s)
    end
  end

  # /watch?v=ID に正規化（/shorts, /embed, youtu.be対応・ID11桁チェック）
  def canonical_watch_url(u)
    host = u.host.downcase
    path = u.path.to_s
    q = Rack::Utils.parse_nested_query(u.query.to_s)
    id =
      if host == "youtu.be"
        path.delete_prefix("/")
      elsif path =~ %r{\A/(?:embed|shorts)/([^/?#]+)}
        Regexp.last_match(1)
      elsif path == "/watch"
        q["v"]
      end
    return nil unless id&.match?(/\A[a-zA-Z0-9_-]{11}\z/)
    "https://www.youtube.com/watch?v=#{id}"
  end
end
