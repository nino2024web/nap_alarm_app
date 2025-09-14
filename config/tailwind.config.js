module.exports = {
    darkMode: "class",
    content: [
      "./app/views/**/*.{erb,html,slim,haml}",
      "./app/helpers/**/*.rb",
      "./app/assets/stylesheets/**/*.{css,scss}",
      "./app/javascript/**/*.{js,ts,jsx,tsx}"
    ],
    theme: { extend: {} },
    plugins: []
  }
  