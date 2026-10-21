'use strict';

const { 
  hashIp, 
  maskEmail, 
  maskPhone, 
  maskName, 
  redactPii, 
  stripQueryString 
} = require('../src/utils/piiRedaction');

const { 
  shouldRedact, 
  redactUri, 
  redactConfig 
} = require('../src/utils/redactConfig');

describe('PII Redaction Utilities', () => {
  describe('maskEmail', () => {
    it('masks email addresses correctly', () => {
      expect(maskEmail('user@example.com')).toBe('u***@example.com');
      expect(maskEmail('admin@school.edu')).toBe('a***@school.edu');
      expect(maskEmail('a@b.com')).toBe('a***@b.com');
    });

    it('handles invalid emails', () => {
      expect(maskEmail('')).toBe('');
      expect(maskEmail('invalid')).toBe('[MASKED]');
      expect(maskEmail(null)).toBe(null);
    });
  });

  describe('maskPhone', () => {
    it('masks phone numbers correctly', () => {
      expect(maskPhone('+1234567890')).toBe('****7890');
      expect(maskPhone('555-123-4567')).toBe('****4567');
      expect(maskPhone('1234567890')).toBe('****7890');
    });

    it('handles short phone numbers', () => {
      expect(maskPhone('123')).toBe('****');
    });
  });

  describe('maskName', () => {
    it('masks single-word names', () => {
      expect(maskName('John')).toBe('J***');
    });

    it('masks multi-word names', () => {
      expect(maskName('John Smith')).toBe('J*** S.');
      expect(maskName('Mary Jane Watson')).toBe('M*** W.');
    });
  });

  describe('redactPii', () => {
    it('redacts PII fields in objects', () => {
      const obj = {
        email: 'user@example.com',
        parentEmail: 'parent@example.com',
        phone: '1234567890',
        name: 'John Smith',
        studentId: 'STU-123456',
        class: '5A',
      };

      const redacted = redactPii(obj);

      expect(redacted.email).toBe('u***@example.com');
      expect(redacted.parentEmail).toBe('p***@example.com');
      expect(redacted.phone).toBe('****7890');
      expect(redacted.name).toBe('J*** S.');
      expect(redacted.studentId).toBe('[REDACTED]');
      expect(redacted.class).toBe('5A'); // Not PII
    });

    it('handles nested objects', () => {
      const obj = {
        user: {
          email: 'user@example.com',
          name: 'John Smith',
        },
        class: '5A',
      };

      const redacted = redactPii(obj);

      expect(redacted.user.email).toBe('u***@example.com');
      expect(redacted.user.name).toBe('J*** S.');
      expect(redacted.class).toBe('5A');
    });

    it('handles arrays', () => {
      const arr = [
        { email: 'user1@example.com', name: 'John' },
        { email: 'user2@example.com', name: 'Jane' },
      ];

      const redacted = redactPii(arr);

      expect(redacted[0].email).toBe('u***@example.com');
      expect(redacted[0].name).toBe('J***');
      expect(redacted[1].email).toBe('u***@example.com');
      expect(redacted[1].name).toBe('J***');
    });
  });

  describe('stripQueryString', () => {
    it('strips query strings from URLs', () => {
      expect(stripQueryString('/api/payments?token=abc123')).toBe('/api/payments');
      expect(stripQueryString('/api/students?search=test&limit=10')).toBe('/api/students');
    });

    it('handles URLs without query strings', () => {
      expect(stripQueryString('/api/payments')).toBe('/api/payments');
    });

    it('handles empty strings', () => {
      expect(stripQueryString('')).toBe('');
    });
  });

  describe('hashIp', () => {
    it('produces consistent hashes for same IP', () => {
      const ip = '192.168.1.1';
      const hash1 = hashIp(ip);
      const hash2 = hashIp(ip);
      expect(hash1).toBe(hash2);
    });

    it('produces different hashes for different IPs', () => {
      const hash1 = hashIp('192.168.1.1');
      const hash2 = hashIp('192.168.1.2');
      expect(hash1).not.toBe(hash2);
    });

    it('handles unknown IPs', () => {
      expect(hashIp('unknown')).toBe('unknown');
      expect(hashIp('')).toBe('unknown');
    });

    it('produces short hashes (16 characters)', () => {
      const hash = hashIp('192.168.1.1');
      expect(hash).toHaveLength(16);
    });
  });

  describe('Config Redaction', () => {
    describe('shouldRedact', () => {
      it('redacts secret-pattern keys', () => {
        expect(shouldRedact('JWT_SECRET')).toBe(true);
        expect(shouldRedact('ADMIN_PASSWORD')).toBe(true);
        expect(shouldRedact('SENDGRID_API_KEY')).toBe(true);
        expect(shouldRedact('WEBHOOK_SECRET_ENCRYPTION_KEY')).toBe(true);
        expect(shouldRedact('MONGO_URI')).toBe(true);
        expect(shouldRedact('TWILIO_AUTH_TOKEN')).toBe(true);
        expect(shouldRedact('ADMIN_PASSWORD_HASH')).toBe(true);
      });

      it('does not redact non-secret keys', () => {
        expect(shouldRedact('PORT')).toBe(false);
        expect(shouldRedact('NODE_ENV')).toBe(false);
        expect(shouldRedact('LOG_LEVEL')).toBe(false);
      });

      it('does not redact allowlisted keys that match pattern', () => {
        expect(shouldRedact('SIGNER_KEY_SOURCE')).toBe(false);
        expect(shouldRedact('EMAIL_PROVIDER')).toBe(false);
        expect(shouldRedact('STELLAR_NETWORK')).toBe(false);
        expect(shouldRedact('AWS_REGION')).toBe(false);
      });
    });


    describe('redactConfig', () => {
      it('redacts all secret-pattern keys', () => {
        const config = {
          JWT_SECRET: 'secret123',
          SENDGRID_API_KEY: 'key123',
          PORT: 3000,
          NODE_ENV: 'production',
          ADMIN_PASSWORD: 'pass123',
        };

        const redacted = redactConfig(config);

        expect(redacted.JWT_SECRET).toBe('[REDACTED]');
        expect(redacted.SENDGRID_API_KEY).toBe('[REDACTED]');
        expect(redacted.ADMIN_PASSWORD).toBe('[REDACTED]');
        expect(redacted.PORT).toBe(3000);
        expect(redacted.NODE_ENV).toBe('production');
      });

      it('redacts credentials in URI values', () => {
        const config = {
          MONGO_URI: 'mongodb://user:pass@host/db',
          REDIS_PASSWORD: 'secret',
          PORT: 3000,
        };

        const redacted = redactConfig(config);

        expect(redacted.MONGO_URI).toBe('mongodb://user:[REDACTED]@host/db');
        expect(redacted.REDIS_PASSWORD).toBe('[REDACTED]');
        expect(redacted.PORT).toBe(3000);
      });

      it('handles undefined values', () => {
        const config = {
          JWT_SECRET: undefined,
          PORT: 3000,
        };

        const redacted = redactConfig(config);

        expect(redacted.JWT_SECRET).toBe(undefined);
        expect(redacted.PORT).toBe(3000);
      });
    });
  });

  describe('Environment Variable Coverage', () => {
    it('redacts all known secret environment variables', () => {
      const knownSecrets = [
        'JWT_SECRET',
        'ADMIN_PASSWORD',
        'ADMIN_PASSWORD_HASH',
        'SCHOOL_ADMIN_PASSWORD',
        'SCHOOL_ADMIN_PASSWORD_HASH',
        'AUDIT_HMAC_KEY',
        'BACKUP_NOTIFY_TOKEN',
        'COINGECKO_API_KEY',
        'EMAIL_PROVIDER_WEBHOOK_SECRET',
        'EMAIL_WEBHOOK_SECRET',
        'METRICS_TOKEN',
        'RECEIPT_SIGNATURE_SECRET',
        'SENDGRID_API_KEY',
        'SIGNER_MASTER_KEY',
        'SIGNER_MASTER_KEY_OLD',
        'SIGNER_MASTER_KEY_HTTP_TOKEN',
        'TWILIO_AUTH_TOKEN',
        'WEBHOOK_SECRET_ENCRYPTION_KEY',
        'WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS',
        'MONGO_URI',
        'MONGODB_URI',
        'REDIS_PASSWORD',
        'SMTP_PASS',
        'STUDENT_PII_ENCRYPTION_KEY',
      ];

      knownSecrets.forEach((secret) => {
        expect(shouldRedact(secret)).toBe(true);
      });
    });
  });
});
