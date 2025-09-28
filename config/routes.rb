Rails.application.routes.draw do
  scope "(:locale)", locale: /en|ja/ do
    root "alarms#new"
    resource :alarm, only: [ :new, :create, :show ]
    get "/oembed", to: "oembeds#show"
  end
end
