import type { Locale } from '../lib/api';
import './Brand.css';

export function Brand({ locale, onClick }: { locale: Locale; onClick: () => void }) {
  return <button className="brand brand-pavilion" onClick={onClick} aria-label={locale === 'zh' ? '沪语漫游 · 返回地图' : 'A little Shanghai · Back to map'}>
    <img className="brand-lockup" src="/brand/pavilion-horizontal.png" width="1944" height="809" alt="" />
    <span className="brand-compact" aria-hidden="true">
      <img src="/brand/pavilion-mark.png" width="1254" height="1254" alt="" />
      <span className="brand-name">{locale === 'zh' ? '沪语漫游' : <>A little<br />Shanghai</>}</span>
    </span>
  </button>;
}
