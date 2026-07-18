/** @type {import("ts-jest").JestConfigWithTsJest} **/
export default {
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "tests/tsconfig.json",
      },
    ],
  },
  testTimeout: 90000,
};
