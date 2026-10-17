import type { Locale } from '../lib/api';
import './Brand.css';

export function Brand({ locale, onClick }: { locale: Locale; onClick: () => void }) {
  return <button className="brand brand-pavilion" onClick={onClick} aria-label={locale === 'zh' ? '沪语漫游 · 返回地图' : 'A little Shanghai · Back to map'}>
    <span className="brand-lockup" aria-hidden="true">
      <img className="brand-symbol" src="/brand/pavilion-mark.png" width="1254" height="1254" alt="" />
      <svg className="brand-wordmark" viewBox="850 310 1010 380" width="110" height="42" focusable="false" overflow="hidden">
        {/* Frame the existing wordmark so its original lettering stays intact. */}
        <image href="/brand/pavilion-horizontal.png" width="1944" height="809" />
      </svg>
    </span>
    <span className="brand-compact" aria-hidden="true">
      <img src="/brand/pavilion-mark.png" width="1254" height="1254" alt="" />
      <span className="brand-name">{locale === 'zh' ? '沪语漫游' : <>A little<br />Shanghai</>}</span>
    </span>
  </button>;
}
