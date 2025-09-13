Rails.application.routes.draw do
  root "alarms#new"
  resource :alarm, only: [ :new, :create, :show ]
  get "/oembed", to: "oembeds#show"
end
