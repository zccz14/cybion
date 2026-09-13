mod cloud;
mod responses;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    cloud::serve().await
}
