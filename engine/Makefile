CXX = g++
CXXFLAGS = -O3 -Wall -std=c++17 -pthread

all: dummy_engine bot_fleet

# The design mandates static binaries for the contestants
dummy_engine: dummy_engine.cpp protocol.h
	$(CXX) $(CXXFLAGS) -static -o $@ $<

bot_fleet: bot_fleet.cpp protocol.h
	$(CXX) $(CXXFLAGS) -o $@ $<

clean:
	rm -f dummy_engine bot_fleet
