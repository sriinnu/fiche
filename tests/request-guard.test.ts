import { describe, expect, it } from 'vitest';
import { guardProxyRequest, hostnameOf, isTrustedHostname, parseAllowedHosts } from '../src/core/request-guard.js';

describe('proxy request guard', () => {
  it.each([
    ['127.0.0.1:47821'],
    ['localhost:47821'],
    ['[::1]:47821'],
    ['api.anthropic.com'], // inkling warp keeps the agent's real Host
    ['chatgpt.com'],
    ['generativelanguage.googleapis.com'],
    ['host.docker.internal:47821'],
    ['inkling:47821'], // compose service name
    ['192.168.1.20:47821'], // LAN bind
    [''],
  ])('lets an agent through with Host %j and no Origin', (host) => {
    expect(guardProxyRequest({ host })).toBeNull();
  });

  it.each([['evil.example:47821'], ['attacker.github.io'], ['127.0.0.1.nip.io:47821']])(
    'refuses rebound Host %j with 421',
    (host) => {
      expect(guardProxyRequest({ host })).toMatchObject({ status: 421, reason: 'untrusted_host' });
    },
  );

  it.each([
    ['https://evil.example'],
    ['http://1.2.3.4'], // a page served from a raw public IP
    ['https://api.anthropic.com'],
    ['null'], // sandboxed iframe / file://
  ])('refuses a browser request from Origin %j with 403', (origin) => {
    expect(guardProxyRequest({ host: '127.0.0.1:47821', origin })).toMatchObject({ status: 403, reason: 'cross_origin' });
  });

  it('accepts loopback page origins', () => {
    expect(guardProxyRequest({ host: '127.0.0.1:47821', origin: 'http://localhost:3000' })).toBeNull();
    expect(guardProxyRequest({ host: '127.0.0.1:47821', origin: 'http://127.0.0.1:47821' })).toBeNull();
  });

  it('honours INKLING_ALLOWED_HOSTS, and * disables the check', () => {
    const allowedHosts = parseAllowedHosts(' proxy.corp.example:8080 , app.corp.example ');
    expect(allowedHosts).toEqual(['proxy.corp.example', 'app.corp.example']);
    expect(guardProxyRequest({ host: 'proxy.corp.example:8080' }, { allowedHosts })).toBeNull();
    expect(guardProxyRequest({ host: '127.0.0.1', origin: 'https://app.corp.example' }, { allowedHosts })).toBeNull();
    expect(guardProxyRequest({ host: 'evil.example' }, { allowedHosts })).not.toBeNull();
    expect(guardProxyRequest({ host: 'evil.example', origin: 'https://evil.example' }, { allowedHosts: ['*'] })).toBeNull();
  });

  it('parses Host authorities', () => {
    expect(hostnameOf('[::1]:47821')).toBe('::1');
    expect(hostnameOf('API.Anthropic.com.')).toBe('api.anthropic.com');
    expect(isTrustedHostname('::1')).toBe(true);
  });
});
