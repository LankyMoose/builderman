import { Link, useFileRouter } from "kiru/router"

const navItems = [
  { path: "/", label: "Home" },
  { path: "/installation", label: "Installation" },
  { path: "/quick-start", label: "Quick Start" },
  { path: "/core-concepts", label: "Core Concepts" },
  { path: "/error-handling", label: "Error Handling" },
  { path: "/cancellation", label: "Cancellation" },
  { path: "/teardown", label: "Teardown" },
  { path: "/skipping-tasks", label: "Skipping Tasks" },
  { path: "/caching", label: "Caching" },
  { path: "/execution-statistics", label: "Execution Statistics" },
  { path: "/advanced-examples", label: "Advanced Examples" },
  { path: "/when-to-use", label: "When to Use" },
]

export default function RootLayout({ children }: { children: JSX.Children }) {
  const { state } = useFileRouter()

  return (
    <div className="min-h-screen flex flex-col">
      <nav className="border-b border-neutral-800 bg-neutral-900/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <Link to="/" className="text-2xl font-bold">
              builderman
            </Link>
            <div className="flex gap-6 flex-wrap">
              {navItems.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`text-sm hover:text-neutral-300 transition-colors ${
                    state.pathname === item.path
                      ? "text-white font-semibold"
                      : "text-neutral-400"
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </nav>
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
