import { ArrowRight, BookOpen, CheckCircle2, Compass, Footprints, Mic, Volume2 } from 'lucide-react';
import type { Locale } from '../lib/api';
import { strings } from '../lib/i18n';
import { Landmark } from './SceneArt';

const aboutCopy = {
  zh: {
    eyebrow: '一小段漫游，一点上海话',
    introduction: '在豫园的日常交流中认识上海话。走进熟悉的小店，从一句招呼、一份点心、一杯茶开始。',
    start: '开始探索', resume: '继续探索',
    placesLabel: '漫游四站', placesTitle: '四个地方，四段小日常。',
    places: [
      ['上海老饭店', '点一道合口味的菜', '聊聊口味，问问推荐，再选一道想吃的上海菜。'],
      ['上海梨膏糖商店', '听一听，挑一种甜', '听店员介绍，找到对应的口味，再核对两包梨膏糖。'],
      ['南翔馒头店', '点热腾腾的小笼', '选好份数和用餐方式，和店员一起核对点单。'],
      ['湖心亭茶楼', '坐下来，说一句谢谢', '尝一口茶，说说味道，再向店员表达谢意。'],
    ],
    stepsLabel: '如何体验', stepsTitle: '每次，只向前一句。',
    steps: [
      ['先听一句', '听店员的提问，看看眼前的小任务。'],
      ['选好，再开口', '选择想表达的内容，跟着提示说出来。'],
      ['看完结果，再继续', '查看识别结果；需要时重试，准备好后点击继续。'],
      ['把表达带走', '完成这一站后，到复习页重听学过的表达。'],
    ],
    supportLabel: '随手可用的帮助', supportTitle: '慢慢来，提示就在身边。',
    support: [
      ['字旁有读音', '拉丁注音对齐汉字，需要时看一眼，也可以随时隐藏。'],
      ['按自己的速度听', '标准速听完整表达，慢速再听一遍。'],
      ['留住这段漫游', '游客进度仅在本次体验中保留。登录后，可以保存进度，下次接着练习。'],
    ],
    savedProgress: '进度已保存到账号，下次登录可以接着练习。完成过的站点也能再练一次。',
    signIn: '登录保存进度',
  },
  en: {
    eyebrow: 'A FEW WORDS, A WHOLE NEW WORLD',
    introduction: 'Discover Shanghainese through everyday encounters in Yu Garden. Step into a shop, order a little something, and share a cup of tea.',
    start: 'Start exploring', resume: 'Continue exploring',
    placesLabel: 'FOUR STOPS', placesTitle: 'Every place has a little story.',
    places: [
      ['Shanghai Old Restaurant', 'Find a dish you will enjoy', 'Share your tastes, ask for a recommendation, and choose a Shanghai dish.'],
      ['Shanghai Pear Candy Shop', 'Listen for something sweet', 'Match the flavor you hear, then confirm two packs of pear candy.'],
      ['Nanxiang Steamed Bun Restaurant', 'Order a little comfort', 'Choose your servings and where to eat, then check your xiaolongbao order.'],
      ['Huxin Pavilion Teahouse', 'Pause over a cup of tea', 'Say how the tea tastes and share a little gratitude with your host.'],
    ],
    stepsLabel: 'HOW IT WORKS', stepsTitle: 'One small exchange at a time.',
    steps: [
      ['Listen first', 'Hear your host’s question and discover the task for this turn.'],
      ['Choose, then speak', 'Pick what you want to say and try it aloud with the hints.'],
      ['Read, then continue', 'See what was heard. Retry if needed, then continue when you are ready.'],
      ['Keep the words close', 'After finishing a stop, visit Review to hear its expressions again.'],
    ],
    supportLabel: 'A LITTLE HELP, ALWAYS CLOSE', supportTitle: 'Make yourself comfortable.',
    support: [
      ['Read along', 'Romanization sits above its matching characters. Keep it nearby or hide it whenever you like.'],
      ['Listen at your pace', 'Hear the expression at normal speed, or slow it down for another listen.'],
      ['Save your journey', 'Guest progress lasts for this visit. Sign in to save it and continue another time.'],
    ],
    savedProgress: 'Your progress is saved to your account. Sign in next time to continue, or try a completed stop again.',
    signIn: 'Sign in to save progress',
  },
};

export default function AboutPage({ locale, hasProgress, onExplore, accountName, onSignIn }: { locale: Locale; hasProgress: boolean; onExplore: () => void; accountName?: string | null; onSignIn?: () => void }) {
  const copy = aboutCopy[locale];
  const s = strings[locale];
  const stops = ['restaurant', 'candy', 'nanxiang', 'teahouse'] as const;
  const stepIcons = [Volume2, Mic, CheckCircle2, BookOpen];
  const supportIcons = [BookOpen, Volume2, Footprints];
  return <div className="about-page page-shell">
    <section className="about-hero" aria-labelledby="about-title">
      <div className="about-hero-copy">
        <span className="overline">{copy.eyebrow}</span>
        <h1 id="about-title">{s.footerTitle}</h1>
        <p className="about-introduction">{copy.introduction}</p>
        <p className="about-invitation">{s.footerText}</p>
        <button type="button" className="primary about-explore" onClick={onExplore}><Compass size={18}/><span>{hasProgress ? copy.resume : copy.start}</span><ArrowRight size={18}/></button>
      </div>
      <div className="about-brand-card">
        <span className="about-brand-location">SHANGHAI · YU GARDEN</span>
        <img src="/brand/pavilion-mark.png" width="1254" height="1254" alt=""/>
        <span className="about-brand-chinese" lang="zh-CN">沪语漫游</span>
        <span className="about-brand-english" lang="en">A little Shanghai</span>
        <span className="about-brand-rule" aria-hidden="true"/>
      </div>
    </section>

    <section className="about-places" aria-labelledby="about-places-title">
      <div className="about-section-heading"><span className="overline">{copy.placesLabel}</span><h2 id="about-places-title">{copy.placesTitle}</h2></div>
      <div className="about-stop-grid">{stops.map((id, index) => <article className={`about-stop about-stop-${id}`} key={id}>
        <div className="about-stop-picture"><span className="about-stop-number" aria-hidden="true">0{index + 1}</span><Landmark kind={id} label={copy.places[index][0]}/></div>
        <div className="about-stop-copy"><h3>{copy.places[index][0]}</h3><p className="about-stop-theme">{copy.places[index][1]}</p><p>{copy.places[index][2]}</p></div>
      </article>)}</div>
    </section>

    <section className="about-how" aria-labelledby="about-how-title">
      <div className="about-section-heading"><span className="overline">{copy.stepsLabel}</span><h2 id="about-how-title">{copy.stepsTitle}</h2></div>
      <ol className="about-steps">{copy.steps.map(([title, description], index) => {
        const Icon = stepIcons[index];
        return <li key={title}><div className="about-step-symbol"><Icon size={24} strokeWidth={1.5}/><span>0{index + 1}</span></div><h3>{title}</h3><p>{description}</p></li>;
      })}</ol>
    </section>

    <section className="about-support" aria-labelledby="about-support-title">
      <div className="about-section-heading"><span className="overline">{copy.supportLabel}</span><h2 id="about-support-title">{copy.supportTitle}</h2></div>
      <div className="about-support-grid">{copy.support.map(([title, description], index) => {
        const Icon = supportIcons[index];
        return <div key={title}><Icon size={23} strokeWidth={1.5}/><h3>{title}</h3><p>{index === 2 && accountName ? copy.savedProgress : description}</p>{index === 2 && !accountName && onSignIn && <button type="button" className="about-sign-in" onClick={onSignIn}>{copy.signIn}<ArrowRight size={16}/></button>}</div>;
      })}</div>
    </section>
  </div>;
}
