ARG BASE_IMAGE=quay.io/slopezpa/fedora-vgpu:latest
ARG LLAMA_CPP_REF=master

FROM ${BASE_IMAGE} AS builder

ARG LLAMA_CPP_REF

RUN dnf install -y \
      ccache \
      cmake \
      gcc \
      gcc-c++ \
      git \
      glslang \
      glslc \
      libcurl-devel \
      make \
      python3 \
      spirv-headers-devel \
      vulkan-loader-devel \
    && dnf clean all

WORKDIR /src
RUN git clone --depth 1 --branch "${LLAMA_CPP_REF}" https://github.com/ggml-org/llama.cpp.git

WORKDIR /src/llama.cpp
RUN cmake -S . -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DGGML_VULKAN=ON \
      -DGGML_NATIVE=OFF \
      -DLLAMA_BUILD_TESTS=OFF \
      -DLLAMA_BUILD_EXAMPLES=OFF \
      -DLLAMA_BUILD_SERVER=ON \
    && cmake --build build --target llama-server llama-cli -j"$(nproc)"

FROM ${BASE_IMAGE}

RUN dnf install -y \
      ca-certificates \
      libcurl \
      vulkan-loader \
    && dnf clean all

WORKDIR /app
COPY --from=builder /src/llama.cpp/build/bin/llama-server /app/llama-server
COPY --from=builder /src/llama.cpp/build/bin/llama-cli /app/llama-cli
COPY --from=builder /src/llama.cpp/build/bin/*.so* /app/
COPY entrypoint.sh /app/entrypoint.sh

ENV LD_LIBRARY_PATH=/app \
    GGML_BACKEND_DIR=/app \
    MODEL_REPO=agentlans/SmolLM2-135M-Instruct-GGUF \
    MODEL_FILE=Q4_K_M.gguf \
    MODEL_ALIAS=smollm2-vulkan \
    HOST=0.0.0.0 \
    PORT=8080 \
    CTX_SIZE=2048 \
    N_GPU_LAYERS=99 \
    THREADS=4

EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
