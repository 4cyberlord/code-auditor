import SwiftUI

@MainActor
final class JobListModel: ObservableObject {
    @Published var jobs: [SolveJob] = []
    @Published var error: String?
    @Published var loading = false

    private let client = SupabaseHistoryClient()

    func refresh() async {
        loading = true
        defer { loading = false }
        do {
            jobs = try await client.jobs()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct JobListView: View {
    @StateObject private var model = JobListModel()
    @State private var path: [SolveJob] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let error = model.error {
                    Text(error).foregroundStyle(.red)
                }
                ForEach(model.jobs) { job in
                    NavigationLink(value: job) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(job.resultSummary.isEmpty ? "Cloud Council job" : job.resultSummary)
                                .lineLimit(2)
                            HStack {
                                Text(job.status)
                                Text(job.progressPhase)
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Code Editor")
            .toolbar {
                Button("Refresh") {
                    Task { await model.refresh() }
                }
            }
            .navigationDestination(for: SolveJob.self) { job in
                JobDetailView(job: job)
            }
            .onReceive(NotificationCenter.default.publisher(for: .openJobFromNotification)) { note in
                guard let raw = note.object as? String else { return }
                Task {
                    await model.refresh()
                    if let job = model.jobs.first(where: { $0.id.uuidString.lowercased() == raw.lowercased() }) {
                        path = [job]
                    }
                }
            }
            .overlay {
                if model.loading {
                    ProgressView()
                }
            }
        }
        .task {
            await model.refresh()
        }
    }
}
