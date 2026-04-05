import { describe, expect, it } from 'vitest';
import { buildToolResultPayloadFromJob, parseToolJobOutputPreview } from './job-results.js';

describe('tool job result helpers', () => {
  it('parses structured JSON previews back into tool output', () => {
    const output = parseToolJobOutputPreview(`{"title":"Doctor's Appointment","startsAt":1775488800000}`);

    expect(output).toEqual({
      title: "Doctor's Appointment",
      startsAt: 1_775_488_800_000,
    });
  });

  it('builds a structured tool payload from a succeeded job preview', () => {
    const payload = buildToolResultPayloadFromJob({
      status: 'succeeded',
      resultPreview: `{"title":"Doctor's Appointment","startsAt":1775488800000}`,
    });

    expect(payload).toEqual({
      success: true,
      output: {
        title: "Doctor's Appointment",
        startsAt: 1_775_488_800_000,
      },
    });
  });

  it('falls back to a plain success message when the preview is not JSON', () => {
    const payload = buildToolResultPayloadFromJob({
      status: 'succeeded',
      resultPreview: 'Executed successfully.',
    });

    expect(payload).toEqual({
      success: true,
      message: 'Executed successfully.',
    });
  });
});
