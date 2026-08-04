import { render, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguagePairSelector } from '../components/LanguagePairSelector';

/** Stubs `fetch` for `GET /api/languages` with the given languages payload. */
function stubLanguages(languages: Array<{ code: string; displayName: string }>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ languages }),
    }),
  );
}

describe('LanguagePairSelector', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Catches the bug where the selector hardcodes its own language list instead of
  // rendering whatever the backend's registry (GET /api/languages) actually reports —
  // a third language added on the backend would never show up in the UI.
  it('renders source and target options from the /api/languages response', async () => {
    stubLanguages([
      { code: 'en', displayName: 'English' },
      { code: 'es', displayName: 'Spanish' },
    ]);

    render(
      <LanguagePairSelector
        pair={{ sourceLang: 'en', targetLang: 'es' }}
        onChange={vi.fn()}
        disabled={false}
      />,
    );

    await waitFor(() => {
      const sourceSelect = screen.getByLabelText('Source') as HTMLSelectElement;
      expect(within(sourceSelect).getAllByRole('option')).toHaveLength(2);
    });

    const sourceSelect = screen.getByLabelText('Source') as HTMLSelectElement;
    const targetSelect = screen.getByLabelText('Target') as HTMLSelectElement;
    expect(within(sourceSelect).getByText('English')).toBeInTheDocument();
    expect(within(sourceSelect).getByText('Spanish')).toBeInTheDocument();
    expect(within(targetSelect).getByText('English')).toBeInTheDocument();
    expect(within(targetSelect).getByText('Spanish')).toBeInTheDocument();
    expect(sourceSelect.value).toBe('en');
    expect(targetSelect.value).toBe('es');
  });

  // Catches the bug this issue centrally relies on for the reverse direction (es -> en):
  // if Swap didn't flip both fields together, a listener could never select the
  // opposite direction of whatever the selector started in.
  it('calls onChange with the pair flipped when Swap is clicked', async () => {
    stubLanguages([
      { code: 'en', displayName: 'English' },
      { code: 'es', displayName: 'Spanish' },
    ]);
    const onChange = vi.fn();

    render(
      <LanguagePairSelector
        pair={{ sourceLang: 'en', targetLang: 'es' }}
        onChange={onChange}
        disabled={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));

    expect(onChange).toHaveBeenCalledWith({ sourceLang: 'es', targetLang: 'en' });
  });

  // Catches the bug where changing just the source (or target) select clobbers the
  // other side of the pair instead of only updating the field the listener touched.
  it('calls onChange with only the source updated when the source select changes', async () => {
    stubLanguages([
      { code: 'en', displayName: 'English' },
      { code: 'es', displayName: 'Spanish' },
    ]);
    const onChange = vi.fn();

    render(
      <LanguagePairSelector
        pair={{ sourceLang: 'en', targetLang: 'es' }}
        onChange={onChange}
        disabled={false}
      />,
    );

    await waitFor(() => {
      expect(within(screen.getByLabelText('Source')).getAllByRole('option')).toHaveLength(2);
    });

    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'es' } });

    expect(onChange).toHaveBeenCalledWith({ sourceLang: 'es', targetLang: 'es' });
  });

  // Catches the bug this issue is centrally about for mid-session safety: if the
  // selector's controls weren't actually disabled while a session is active, a
  // listener could change languages out from under a live session (issue #9 territory).
  it('disables both selects and the swap button when disabled is true', () => {
    stubLanguages([{ code: 'en', displayName: 'English' }]);

    render(
      <LanguagePairSelector
        pair={{ sourceLang: 'en', targetLang: 'es' }}
        onChange={vi.fn()}
        disabled
      />,
    );

    expect(screen.getByLabelText('Source')).toBeDisabled();
    expect(screen.getByLabelText('Target')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  // Catches the bug where a failed language fetch fails silently, leaving a listener
  // staring at an empty selector with no indication anything went wrong.
  it('shows an error message when the language list fails to load', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    render(
      <LanguagePairSelector
        pair={{ sourceLang: 'en', targetLang: 'es' }}
        onChange={vi.fn()}
        disabled={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('status 500');
    });
  });
});
