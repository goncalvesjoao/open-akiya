import SyntheticMap from './SyntheticMap'

const repository = 'https://github.com/goncalvesjoao/open-akiya'

function HouseMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="m4 15 12-11 12 11M8 12v16h16V12M13 28V18h6v10"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Landscape() {
  return (
    <svg
      className="landscape"
      viewBox="0 0 640 560"
      role="img"
      aria-labelledby="landscape-title"
    >
      <title id="landscape-title">
        Illustration of a home among Japan’s mountains, with map markers
      </title>
      <defs>
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M40 0H0v40" fill="none" stroke="#d8dfd3" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="640" height="560" fill="#e8ede3" />
      <rect width="640" height="560" fill="url(#grid)" />
      <path
        d="M-20 370 125 146 260 333 393 116 660 395V560H0Z"
        fill="#c9d5c4"
      />
      <path
        d="m-30 438 216-219 172 198 150-178 162 163v158H0Z"
        fill="#acbfa9"
      />
      <path d="M-20 507q154-136 332-27T680 409V580H-20Z" fill="#8ca78c" />
      <path
        d="M410 560q-120-105-63-170t-12-90"
        fill="none"
        stroke="#f5f3eb"
        strokeWidth="24"
      />
      <path d="m197 309 114-90 116 90Z" fill="#364c41" />
      <path d="M219 309h185v125H219Z" fill="#f4eedb" />
      <path d="M303 337h44v97h-44Z" fill="#8d6349" />
      <path d="M241 335h39v42h-39ZM366 335h21v42h-21Z" fill="#759084" />
      <path d="M260 335v42M241 356h39" stroke="#f4eedb" strokeWidth="3" />
      <path d="M204 435h213" stroke="#364c41" strokeWidth="8" />
      <g fill="#294e41">
        <path d="M137 211c-27 0-40 31-25 51l25 33 25-33c15-20 2-51-25-51Z" />
        <path d="M490 327c-27 0-40 31-25 51l25 33 25-33c15-20 2-51-25-51Z" />
      </g>
      <g fill="#f5f3eb">
        <circle cx="137" cy="246" r="10" />
        <circle cx="490" cy="362" r="10" />
      </g>
      <circle cx="495" cy="108" r="35" fill="#e0b37c" />
      <g stroke="#53745c" strokeWidth="9" strokeLinecap="round">
        <path d="M91 432v64m-21-32 21-32 21 32M531 435v64m-21-32 21-32 21 32" />
      </g>
    </svg>
  )
}

export default function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header container">
        <a className="brand" href="#" aria-label="Open Akiya home">
          <HouseMark />
          <span>
            open akiya<span className="brand-dot">.</span>
          </span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#about">The idea</a>
          <a href="#map">Synthetic map</a>
          <a href={repository} className="github-link">
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>
      <main id="main">
        <section className="hero container" aria-labelledby="hero-title">
          <div className="hero-copy">
            <span className="eyebrow">
              <span className="status-dot" /> OPEN SOURCE · EARLY DAYS
            </span>
            <h1 id="hero-title">
              An empty house.
              <br />A new beginning.
              <br />
              <em>An open map.</em>
            </h1>
            <p className="intro">Discover Japan’s vacant homes, freely.</p>
            <p className="hero-description">
              We’re building a shared map of public akiya listings, with
              translated details and a path back to every original source. Open
              for anyone to explore.
            </p>
            <div className="actions">
              <a className="button" href={repository}>
                Build with us <span aria-hidden="true">↗</span>
              </a>
              <a className="text-link" href="#about">
                Meet the project <span aria-hidden="true">↓</span>
              </a>
            </div>
            <p className="availability">
              Explore the synthetic map below. Help shape what comes next.
            </p>
          </div>
          <div className="hero-art">
            <Landscape />
            <div className="art-label">
              <span>空き家</span>
              <div>
                Akiya <span>/ vacant home</span>
              </div>
            </div>
            <span className="preview-label">
              A little vision of what’s ahead · Illustration
            </span>
          </div>
        </section>
        <SyntheticMap />
        <section
          className="about container"
          id="about"
          aria-labelledby="about-title"
        >
          <div className="section-intro">
            <span className="eyebrow">
              PUBLIC INFORMATION. SHARED POSSIBILITY.
            </span>
            <h2 id="about-title">
              A clearer way to
              <br />
              find a place in Japan.
            </h2>
            <p>
              Local akiya banks share homes looking for their next chapter. Open
              Akiya aims to make those listings easier to find, understand, and
              explore together.
            </p>
          </div>
          <div className="principles">
            <article>
              <span className="number">01 /</span>
              <h3>One map, many communities</h3>
              <p>
                Bring together listings from local akiya banks, so discovery can
                start with a place instead of a search through scattered
                websites.
              </p>
            </article>
            <article>
              <span className="number">02 /</span>
              <h3>Across the language barrier</h3>
              <p>
                Make Japanese listing details easier to understand, while
                keeping the original source close at hand.
              </p>
            </article>
            <article>
              <span className="number">03 /</span>
              <h3>Built in the open</h3>
              <p>
                Free access is the goal. Developers, translators, and people who
                know their local communities can help bring it to life.
              </p>
            </article>
          </div>
        </section>
        <section
          className="contribute container"
          aria-labelledby="contribute-title"
        >
          <div>
            <span className="eyebrow">A SMALL START. AN OPEN INVITATION.</span>
            <h2 id="contribute-title">Help put possibility on the map.</h2>
            <p>
              Have an idea, a local source, or a little code to contribute? Join
              us on GitHub.
            </p>
          </div>
          <a className="button" href={repository}>
            Explore the repository <span aria-hidden="true">↗</span>
          </a>
        </section>
      </main>
      <footer className="container">
        <a className="brand" href="#">
          <HouseMark />
          <span>open akiya.</span>
        </a>
        <p>Discover Japan’s vacant homes, freely.</p>
        <a href={`${repository}/blob/main/LICENSE`}>
          MIT licensed <span aria-hidden="true">↗</span>
        </a>
      </footer>
    </>
  )
}
