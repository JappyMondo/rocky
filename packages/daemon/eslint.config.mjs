import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    // The web shell's built bundle, copied in by `bundle-web`.
    ignores: ['public'],
  },
];
