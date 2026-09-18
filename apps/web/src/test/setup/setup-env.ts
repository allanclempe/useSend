const defaultEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3000",
  APP_SECRET: "test-secret",
  BETTER_AUTH_SECRET: "test-better-auth-secret",
  // Placeholder. Real deployments generate this with `openssl rand -hex 32`.
  API_KEY_HMAC_SECRET: "test-api-key-hmac-secret-not-a-real-key",
  DATABASE_URL: "postgresql://usesend:password@127.0.0.1:54329/usesend_test",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
  AWS_DEFAULT_REGION: "us-east-1",
  // Not a container the suite starts, and nothing here reaches AWS -- the
  // tests that touch SES mock `~/server/aws/ses` wholesale. They are set
  // because `src/env.js` requires an endpoint outside production, and because
  // a test that slipped past its mock should fail on a closed local port
  // rather than reach somebody's real SES account.
  AWS_SES_ENDPOINT: "http://localhost:5350/api/ses",
  AWS_SNS_ENDPOINT: "http://localhost:5350/api/sns",
  NEXT_PUBLIC_IS_CLOUD: "true",
  API_RATE_LIMIT: "2",
  AUTH_EMAIL_RATE_LIMIT: "5",
};

for (const [key, value] of Object.entries(defaultEnv)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}
