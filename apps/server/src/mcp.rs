#![recursion_limit = "512"]

mod crypto;
mod design_budgets;
mod falkordb;
mod forecasts;
mod indexer;
mod library;
mod mcp_app;
mod project_graphs;
mod resources;
mod workflows;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    mcp_app::run().await
}
