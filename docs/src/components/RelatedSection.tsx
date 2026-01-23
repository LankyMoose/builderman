export default function RelatedSection({
  children,
}: {
  children: JSX.Children
}) {
  return (
    <div className="mt-8 p-4 bg-blue-900/20 border-2 border-blue-800/75 rounded-lg">
      {children}
    </div>
  )
}
