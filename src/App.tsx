import { useEffect, useState } from "react";
import { dashboardFeatures, resolveFeature } from "./features/registry";

function routeFromHash() {
  return location.hash.slice(1).split("?")[0] || dashboardFeatures[0].route;
}

export default function App() {
  const [route, setRoute] = useState(routeFromHash);
  useEffect(() => {
    if (!location.hash) location.replace(`#${dashboardFeatures[0].route}`);
    const onHashChange = () => setRoute(routeFromHash());
    addEventListener("hashchange", onHashChange);
    return () => removeEventListener("hashchange", onHashChange);
  }, []);
  const feature = resolveFeature(route);
  const Feature = feature.component;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href={`#${dashboardFeatures[0].route}`}>
          <span className="brand__mark">AZ</span>
          <span>
            <strong>Azure SDK JS</strong>
            <small>Engineering dashboard</small>
          </span>
        </a>
        <span className="public-badge">Public · read only</span>
      </header>
      <div className="app-layout">
        <nav className="sidebar" aria-label="Dashboard sections">
          {dashboardFeatures.map((item) => (
            <a
              href={`#${item.route}`}
              key={item.id}
              className={item.id === feature.id ? "active" : ""}
              aria-current={item.id === feature.id ? "page" : undefined}
            >
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </a>
          ))}
        </nav>
        <main>
          <div className="page-heading">
            <div>
              <p className="eyebrow">Azure SDK for JavaScript</p>
              <h1>{feature.label}</h1>
              <p>{feature.description}</p>
            </div>
            <a
              className="button-secondary"
              href="https://github.com/Azure/azure-sdk-for-js/pulls"
              target="_blank"
              rel="noreferrer"
            >
              View repository
            </a>
          </div>
          <Feature />
        </main>
      </div>
    </div>
  );
}
