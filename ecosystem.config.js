module.exports = {
    apps: [
      {
        name: "api",
        script: "./server.js",
        env: {
          PORT: 3001,
          NODE_ENV: "development"
        },
        env_production: {
          NODE_ENV: "production"
        },
        env_file: ".env"
      }
    ]
  };