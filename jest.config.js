/** @type {import("jest").Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  silent: false,
  
  // Only scan these directories
  roots: ["<rootDir>/src", "<rootDir>/test-ts"],

  testMatch: ["<rootDir>/test-ts/**/*.spec.ts"],

  // Extra safety: regex ignores (do not rely on <rootDir> substitution here)
  testPathIgnorePatterns: ["/node_modules/", "/target/", "/build/", "/out/", "/coverage/"],
  modulePathIgnorePatterns: ["/target/", "/build/", "/out/"],
  watchPathIgnorePatterns: ["/target/", "/build/", "/out/", "/coverage/"],

  haste: {
    enableSymlinks: false,
  },
};