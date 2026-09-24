'use strict';

// Unit tests import modules whose configuration is evaluated immediately.
// Use an explicit, test-only key so the suite never relies on the dev fallback.
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'unit-test-only-jwt-secret';
