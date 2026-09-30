/** Host-owned behavioral matrix, injected only into the disposable check container. */
export function att764Acceptance(product: boolean) {
  return `import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PeopleManagement } from './index';
const state = vi.hoisted(() => ({ locale: 'en' }));
vi.mock('@attraccess/plugins-frontend-ui', () => ({ useTranslations: (d: any) => ({ t: (key: string) => key.split('.').reduce((v: any, k: string) => v?.[k], d[state.locale]) ?? key }) }));
vi.mock('./usePeopleRows', () => ({ usePeopleRows: () => ({ rows: [], isLoading: false, hasError: false }) }));
vi.mock('./usePeopleMutations', () => ({ usePeopleMutations: () => ({}) }));
vi.mock('./PeopleTable', () => ({ PeopleTable: () => null }));
vi.mock('./AddPersonDrawer', () => ({ AddPersonDrawer: () => null }));
vi.mock('./IntroductionCommentModal', () => ({ IntroductionCommentModal: () => null }));
vi.mock('./HistoryModalLoader', () => ({ HistoryModalLoader: () => null }));
vi.mock('../../../components/select', () => ({ Select: () => null }));
vi.mock('../../../components/pageHeader', () => ({ PageHeader: (p: any) => <header><h1>{p.title}</h1><p data-testid="subtitle">{p.subtitle}</p></header> }));
afterEach(cleanup);
for (const locale of ['en', 'de']) for (const type of ['resource', 'group'] as const) for (const manage of [false, true]) for (const hidden of [false, true]) {
  it('ATT-764 ' + locale + '/' + type + '/manage=' + manage + '/hidden=' + hidden, () => {
    state.locale = locale;
    render(<PeopleManagement target={{type, id: 7}} canManageIntroducers={manage} canManageIntroductions={manage} hideHeader={hidden} />);
    if (hidden) { expect(screen.queryByRole('heading')).toBeNull(); expect(screen.queryByTestId('subtitle')).toBeNull(); return; }
    expect(screen.getByRole('heading').textContent).toBe(locale === 'en' ? 'People & Permissions' : 'Personen & Berechtigungen');
    const text = screen.getByTestId('subtitle').textContent;
    if (type === 'resource') expect(text).toBe(locale === 'en' ? 'Manage introducers, maintainers and introductions for this resource' : 'Einweiser, Wartende und Einweisungen für diese Ressource verwalten');
    else if (${product}) { expect(text).toMatch(locale === 'en' ? /\\bgroup\\b/i : /\\bGruppe\\b/i); expect(text).not.toMatch(locale === 'en' ? /\\bresource\\b/i : /\\bRessource\\b/i); }
  });
}
`;
}
