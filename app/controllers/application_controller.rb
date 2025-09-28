class ApplicationController < ActionController::Base
  before_action :set_locale
  before_action :ensure_locale_in_url

  private

  def set_locale
    I18n.available_locales = %i[en ja]
    I18n.default_locale = :en

    locale =
      if params[:locale].present?
        params[:locale].to_sym
      elsif cookies[:locale].present?
        cookies[:locale].to_sym
      else
        I18n.default_locale
      end

    I18n.locale = I18n.available_locales.include?(locale) ? locale : I18n.default_locale
    cookies[:locale] = I18n.locale
  end

  def default_url_options
    { locale: I18n.locale }
  end

  def ensure_locale_in_url
    return if params[:locale].present?
    return unless request.get?
    return unless request.format.html?
    return if request.xhr?
    return if request.path.start_with?("/oembed")

    redirect_to url_for(locale: I18n.locale)
  end
end
