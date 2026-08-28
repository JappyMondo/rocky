import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  DEFAULT_LOG_LEVEL,
  DEFAULT_PORT,
  DeployConfigError,
  formatDeployConfigError,
  generateEncryptionKey,
  loadDeployConfig,
} from './deploy-config';

const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ROCKY_ENCRYPTION_KEY: VALID_KEY,
    ROCKY_BASE_URL: 'https://rocky.example.com',
    ...overrides,
  };
}

/** Runs the loader and returns the error it threw. */
function problemsFrom(environment: NodeJS.ProcessEnv): DeployConfigError {
  try {
    loadDeployConfig(environment);
  } catch (error) {
    return error as DeployConfigError;
  }
  throw new Error('Expected loadDeployConfig to throw, but it returned.');
}

describe('loadDeployConfig', () => {
  it('reads the four variables and defaults the two optional ones', () => {
    expect(loadDeployConfig(env())).toEqual({
      encryptionKey: VALID_KEY,
      baseUrl: 'https://rocky.example.com',
      port: DEFAULT_PORT,
      logLevel: DEFAULT_LOG_LEVEL,
    });
  });

  it('reads the optional variables when they are set', () => {
    const config = loadDeployConfig(
      env({ ROCKY_PORT: '8080', ROCKY_LOG_LEVEL: 'DEBUG' }),
    );

    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe('debug');
  });

  it('normalises away a trailing slash on the base URL', () => {
    expect(
      loadDeployConfig(env({ ROCKY_BASE_URL: 'https://rocky.example.com/' }))
        .baseUrl,
    ).toBe('https://rocky.example.com');
  });

  it('keeps a sub-path on the base URL', () => {
    expect(
      loadDeployConfig(env({ ROCKY_BASE_URL: 'https://example.com/rocky/' }))
        .baseUrl,
    ).toBe('https://example.com/rocky');
  });

  it('treats a blank value as absent', () => {
    expect(loadDeployConfig(env({ ROCKY_PORT: '   ' })).port).toBe(
      DEFAULT_PORT,
    );
    expect(problemsFrom(env({ ROCKY_BASE_URL: '' })).problems).toEqual([
      expect.stringContaining('ROCKY_BASE_URL is required'),
    ]);
  });

  describe('refuses to start', () => {
    it('when the encryption key is missing, offering a generated one', () => {
      const error = problemsFrom({
        ROCKY_BASE_URL: 'https://rocky.example.com',
      });

      expect(error.problems).toEqual([
        'ROCKY_ENCRYPTION_KEY is required but was not set.',
      ]);
      expect(
        Buffer.from(error.generatedEncryptionKey ?? '', 'base64'),
      ).toHaveLength(32);
    });

    it('when the base URL is missing', () => {
      const error = problemsFrom({ ROCKY_ENCRYPTION_KEY: VALID_KEY });

      expect(error.problems).toEqual([
        expect.stringContaining('ROCKY_BASE_URL is required'),
      ]);
      // Nothing was wrong with the key, so there is no reason to offer a new one.
      expect(error.generatedEncryptionKey).toBeUndefined();
    });

    it('when the encryption key is the wrong length', () => {
      const error = problemsFrom(
        env({ ROCKY_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
      );

      expect(error.problems).toEqual([
        expect.stringContaining('decoded to 16 bytes'),
      ]);
      // The key was supplied, just wrong; replacing it silently would discard
      // the key that decrypts an existing database.
      expect(error.generatedEncryptionKey).toBeUndefined();
    });

    it.each([
      ['not-a-url', 'not a valid absolute URL'],
      ['ftp://rocky.example.com', 'must be http or https'],
      ['https://rocky.example.com?a=b', 'must not carry a query string'],
    ])('when the base URL is %s', (baseUrl, expected) => {
      expect(problemsFrom(env({ ROCKY_BASE_URL: baseUrl })).problems).toEqual([
        expect.stringContaining(expected),
      ]);
    });

    it.each(['0', '70000', 'http', '80.5'])('when the port is %s', (port) => {
      expect(problemsFrom(env({ ROCKY_PORT: port })).problems).toEqual([
        expect.stringContaining('ROCKY_PORT must be an integer'),
      ]);
    });

    it('when the log level is not one we know', () => {
      expect(problemsFrom(env({ ROCKY_LOG_LEVEL: 'chatty' })).problems).toEqual(
        [expect.stringContaining('ROCKY_LOG_LEVEL must be one of')],
      );
    });

    it('reporting every problem at once, not one restart at a time', () => {
      const error = problemsFrom({
        ROCKY_PORT: 'nope',
        ROCKY_LOG_LEVEL: 'loud',
      });

      expect(error.problems).toHaveLength(4);
    });
  });
});

describe('formatDeployConfigError', () => {
  it('prints a pasteable key when the encryption key is missing', () => {
    const message = formatDeployConfigError(
      problemsFrom({ ROCKY_BASE_URL: 'https://rocky.example.com' }),
    );

    expect(message).toContain('ROCKY_ENCRYPTION_KEY=');
    // Refusing to write the key next to the database is the whole point of
    // printing it instead of generating it into /data.
    expect(message).toContain('/data');
    expect(message).toContain('same backup tarball');
  });

  it('does not offer a key when the key was not the problem', () => {
    const message = formatDeployConfigError(
      problemsFrom({ ROCKY_ENCRYPTION_KEY: VALID_KEY }),
    );

    expect(message).not.toContain('ROCKY_ENCRYPTION_KEY=');
    expect(message).toContain('ROCKY_BASE_URL is required');
  });
});

describe('the configuration surface', () => {
  const sources = productionSources();

  it('is exactly these four variables', () => {
    const referenced = new Set(
      sources.flatMap(
        (file) => readFileSync(file, 'utf-8').match(/ROCKY_[A-Z_]+/g) ?? [],
      ),
    );

    expect([...referenced].sort()).toEqual([
      'ROCKY_BASE_URL',
      'ROCKY_ENCRYPTION_KEY',
      'ROCKY_LOG_LEVEL',
      'ROCKY_PORT',
    ]);
  });

  it('is read from the environment in exactly one place', () => {
    const readers = sources.filter((file) =>
      /process\.env/.test(readFileSync(file, 'utf-8')),
    );

    // Anything else reading process.env would be a setting with two homes, and
    // nobody could tell which one won.
    expect(readers.map((file) => basename(file))).toEqual(['main.ts']);
  });

  it('has no config file to fall back to', () => {
    const configFiles = readdirSync(join(__dirname, '..', '..'), {
      withFileTypes: true,
    }).filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.startsWith('.env') ||
          /^(rocky|config)\.(ya?ml|json|toml|ini)$/i.test(entry.name)),
    );

    expect(configFiles.map((entry) => entry.name)).toEqual([]);
  });
});

/** Every non-spec TypeScript file under the server's src directory. */
function productionSources(dir = join(__dirname, '..')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return productionSources(full);
    }
    const isSpec = entry.name.endsWith('.spec.ts');
    return entry.isFile() && entry.name.endsWith('.ts') && !isSpec
      ? [full]
      : [];
  });
}

describe('generateEncryptionKey', () => {
  it('generates 32 bytes of base64, fresh each time', () => {
    const first = generateEncryptionKey();

    expect(Buffer.from(first, 'base64')).toHaveLength(32);
    expect(first).not.toBe(generateEncryptionKey());
  });
});
