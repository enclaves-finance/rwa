// solidity-coverage configuration.
//
// Coverage is enforced in CI as a non-negotiable floor; raise the numbers
// once we have more test surface, but never lower them silently — bump
// only when adding deliberate, justified-in-PR-description exemptions.
//
// https://github.com/sc-forks/solidity-coverage/blob/master/docs/api.md

module.exports = {
  istanbulReporter: ['text-summary', 'html', 'lcov', 'json-summary'],
  configureYulOptimizer: true,
  // External / vendored code is excluded from the floor so that upstream
  // gaps don't drag the headline number down; they're separately covered
  // by their own audits.
  skipFiles: [
    'external/',
    'mocks/',
  ],
  mocha: {
    timeout: 300000,
  },
};
