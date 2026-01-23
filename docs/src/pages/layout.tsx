import { Link, useFileRouter } from "kiru/router"

const navGroups = [
  {
    label: "Getting Started",
    items: [
      { path: "/", label: "Features" },
      { path: "/installation", label: "Installation" },
      { path: "/quick-start", label: "Quick Start" },
    ],
  },
  {
    label: "Core",
    items: [
      { path: "/core-concepts", label: "Core Concepts" },
      { path: "/error-handling", label: "Error Handling" },
      { path: "/cancellation", label: "Cancellation" },
      { path: "/teardown", label: "Teardown" },
    ],
  },
  {
    label: "Features",
    items: [
      { path: "/skipping-tasks", label: "Skipping Tasks" },
      { path: "/caching", label: "Caching" },
      { path: "/execution-statistics", label: "Statistics" },
    ],
  },
  {
    label: "More",
    items: [
      { path: "/advanced-examples", label: "Examples" },
      { path: "/when-to-use", label: "When to Use" },
    ],
  },
]

export default function RootLayout({ children }: { children: JSX.Children }) {
  const { state, baseUrl } = useFileRouter()

  const isActive = (path: string) => {
    const basePath = state.pathname.slice(baseUrl.length)
    if (path === "/") {
      return basePath === "/"
    }

    return basePath.startsWith(path)
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-neutral-800 bg-neutral-900/50 p-6 flex flex-col gap-6">
        <div className="text-center">
          <h1 className="text-5xl font-bold mb-4">
            <Link to="/">builderman</Link>
          </h1>
          <span className="text-xl text-neutral-400 mb-8 inline-block">
            A dependency-aware task runner for building, developing, and
            orchestrating complex workflows
          </span>
        </div>
        <nav>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
            {navGroups.map((group) => (
              <div key={group.label} className="flex flex-col items-center">
                <div>
                  <h2 className="text-lg font-semibold mb-2">{group.label}</h2>
                  <ul className="list-none pl-0">
                    {group.items.map((item) => (
                      <li key={item.path}>
                        <Link
                          to={item.path}
                          className={`text-sm hover:text-neutral-300 transition-colors ${
                            isActive(item.path)
                              ? "text-white font-semibold"
                              : "text-neutral-400"
                          }`}
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </nav>
      </header>
      <main className="flex-1 max-w-4xl mx-auto px-6 py-12 w-full prose prose-invert">
        {children}
      </main>
      {/* <footer className="border-t border-neutral-800 mt-auto py-8">
        <div className="max-w-7xl mx-auto px-6 text-center text-neutral-400 text-sm">
          <p>builderman - A dependency-aware task runner</p>
        </div>
      </footer> */}
    </div>
  )
}
