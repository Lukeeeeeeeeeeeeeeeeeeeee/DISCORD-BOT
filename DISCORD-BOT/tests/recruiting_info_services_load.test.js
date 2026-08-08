describe('recruiting info service module graph', () => {
  test('recruiter info service loads without missing repo dependencies', () => {
    expect(() => require('../src/services/recruiting/recruiter-info-service')).not.toThrow();
  });

  test('member info service loads without missing repo dependencies', () => {
    expect(() => require('../src/services/recruiting/info-service')).not.toThrow();
  });
});
