import AreaMap from './AreaMap'
export default function App() {
  return (
    <>
      <header className="container">
        <h1>Open Akiya</h1>
        <p>
          Discover Japan’s vacant homes, freely. Your saved listings stay on
          this computer.
        </p>
      </header>
      <main>
        <AreaMap />
      </main>
    </>
  )
}
