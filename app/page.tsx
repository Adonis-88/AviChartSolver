export default function AppHome() {
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold">AviChartSolver</h1>
      <p className="mt-2 text-slate-600">
        App workspace (paywall later). Start with Figure 3.
      </p>

      <div className="mt-4 flex flex-col gap-2">
        <a className="underline text-blue-600" href="/figure/3">
          Go to Figure 3
        </a>
        <a className="underline text-blue-600" href="/figure/4">
          Go to Figure 4
        </a>
      </div>
    </main>
  );
}
