/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.jest.json" }],
  },
  globalSetup: "<rootDir>/test/globalSetup.ts",
  setupFiles: ["<rootDir>/test/env.ts"],
  setupFilesAfterEnv: ["<rootDir>/test/setupAfterEnv.ts"],
  testTimeout: 20000,
  verbose: true,
};
